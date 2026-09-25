// =============================================================================
// scraper/tests/documentDiscovery.test.js
// =============================================================================
// WHAT: STEP 4 tests — broader document discovery for SOURCE_VERIFIED sources.
//   Covers category discovery (bulletin/notification/corrigendum/registration/
//   syllabus/eligibility/dates), relevance scoring + ordering, boilerplate
//   filtering, relative URL resolution, dedup, revision preservation,
//   same-domain restriction, depth/page/document bounds, evidence shape,
//   determinism, verification gating, and the no-extraction/no-publish
//   boundaries.
// WHY: Later stages need a ranked, evidenced, bounded document list — not a
//   single first-match bulletin and not an unbounded crawl.
// DB: none — discovery is pure/in-memory over fixtures and stub fetchers
//   (one local-server test exercises the default fetcher path).
// RUN: npm test (node --test)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");

const {
  DOCUMENT_CATEGORIES,
  SCORE_THRESHOLD,
  discoverDocumentsFromPages,
  discoverFromSource,
} = require("../discovery/documentDiscovery");

const RETRIEVED_AT = new Date("2026-09-23T00:00:00Z");

function verifiedSource(overrides = {}) {
  return {
    sourceUrl: "http://127.0.0.1/",
    sourceDomain: "127.0.0.1",
    verificationStatus: "SOURCE_VERIFIED",
    ...overrides,
  };
}

const LANDING_HTML =
  "<html><head><title>Test Board</title></head><body>" +
  '<a href="/docs/bulletin-2027.pdf">Information Bulletin 2027</a>' +
  '<a href="/docs/revised-bulletin-2027.pdf">Revised Information Bulletin 2027</a>' +
  '<a href="/docs/corrigendum-2.pdf">Corrigendum 2</a>' +
  '<a href="/notices.html">Examination Notifications</a>' +
  '<a href="/dates.html">Important Dates Schedule</a>' +
  '<a href="/syllabus.html">Syllabus and Exam Pattern</a>' +
  '<a href="/eligibility.html">Eligibility Criteria</a>' +
  '<a href="/registration.html">Online Application Registration</a>' +
  '<a href="/login">Login</a>' +
  '<a href="/contact-us">Contact Us</a>' +
  '<a href="https://external.example.com/notice.pdf">External Notice</a>' +
  '<a href="/docs/bulletin-2027.pdf">Information Bulletin 2027 mirror</a>' +
  "</body></html>";

describe("STEP 4 — document discovery categories and scoring", () => {
  it("1. discovers bulletins, notifications, dates, syllabus, eligibility", () => {
    const { documents } = discoverDocumentsFromPages(verifiedSource(), [
      { url: "http://127.0.0.1/", html: LANDING_HTML, depth: 0 },
    ]);
    const byLabel = {};
    for (const doc of documents) {
      byLabel[doc.label] = byLabel[doc.label] || [];
      byLabel[doc.label].push(doc);
    }
    assert.ok(byLabel.BULLETIN.length >= 1, "bulletin found");
    assert.ok(byLabel.NOTIFICATION.length >= 1, "notification page found");
    assert.ok(byLabel.IMPORTANT_DATES.length >= 1, "dates page found");
    assert.ok(byLabel.SYLLABUS.length >= 1, "syllabus page found");
    assert.ok(byLabel.ELIGIBILITY.length >= 1, "eligibility page found");
    assert.ok(byLabel.REGISTRATION.length >= 1, "registration page found");
    const bulletin = documents.find((d) => d.title === "Information Bulletin 2027");
    assert.equal(bulletin.documentType, "PDF");
    assert.equal(bulletin.url, "http://127.0.0.1/docs/bulletin-2027.pdf");
    assert.ok(bulletin.relevanceScore >= SCORE_THRESHOLD);
  });

  it("2. corrigenda and revisions stay separately discoverable, revised outranks", () => {
    const { documents } = discoverDocumentsFromPages(verifiedSource(), [
      { url: "http://127.0.0.1/", html: LANDING_HTML, depth: 0 },
    ]);
    const original = documents.find((d) => d.title === "Information Bulletin 2027");
    const revised = documents.find((d) => d.title === "Revised Information Bulletin 2027");
    const corrigendum = documents.find((d) => d.title === "Corrigendum 2");
    assert.ok(original && revised && corrigendum, "all three revisions preserved");
    assert.equal(corrigendum.label, "CORRIGENDUM");
    assert.ok(revised.relevanceScore > original.relevanceScore, "revision bonus orders revised above original");
  });

  it("3. results are ordered by score desc, then url asc (deterministic)", () => {
    const run = () =>
      discoverDocumentsFromPages(verifiedSource(), [{ url: "http://127.0.0.1/", html: LANDING_HTML, depth: 0 }]);
    const first = run().documents;
    const second = run().documents;
    assert.deepEqual(
      first.map((d) => d.url),
      second.map((d) => d.url)
    );
    for (let i = 1; i < first.length; i += 1) {
      assert.ok(first[i - 1].relevanceScore >= first[i].relevanceScore, "scores descend");
      if (first[i - 1].relevanceScore === first[i].relevanceScore) {
        assert.ok(first[i - 1].url <= first[i].url, "ties break by url");
      }
    }
  });

  it("4. boilerplate and cross-domain links are filtered with stats", () => {
    const { documents, stats } = discoverDocumentsFromPages(verifiedSource(), [
      { url: "http://127.0.0.1/", html: LANDING_HTML, depth: 0 },
    ]);
    assert.ok(!documents.some((d) => /login|contact/i.test(d.title || "")), "boilerplate dropped");
    assert.ok(!documents.some((d) => d.url.includes("external.example.com")), "cross-domain dropped");
    assert.ok(stats.droppedBoilerplate >= 2);
    assert.ok(stats.droppedCrossDomain >= 1);
  });

  it("5. relative URLs resolve and duplicates collapse to one entry", () => {
    const { documents, stats } = discoverDocumentsFromPages(verifiedSource(), [
      { url: "http://127.0.0.1/", html: LANDING_HTML, depth: 0 },
    ]);
    const bulletins = documents.filter((d) => d.url === "http://127.0.0.1/docs/bulletin-2027.pdf");
    assert.equal(bulletins.length, 1);
    assert.ok(stats.duplicates >= 1);
  });

  it("6. every document preserves why it was selected", () => {
    const { documents } = discoverDocumentsFromPages(
      verifiedSource(),
      [{ url: "http://127.0.0.1/", html: LANDING_HTML, depth: 0 }],
      { discoveredAt: RETRIEVED_AT }
    );
    assert.ok(documents.length > 0);
    for (const doc of documents) {
      assert.equal(typeof doc.url, "string");
      assert.equal(doc.sourceUrl, "http://127.0.0.1/");
      assert.ok(DOCUMENT_CATEGORIES.includes(doc.label));
      assert.equal(typeof doc.title, "string");
      assert.ok(["PDF", "HTML"].includes(doc.documentType));
      assert.equal(typeof doc.relevanceScore, "number");
      assert.ok(Array.isArray(doc.matchedSignals) && doc.matchedSignals.length > 0);
      assert.deepEqual(new Date(doc.discoveredAt), RETRIEVED_AT);
      assert.equal(doc.depth, 1);
    }
    const bulletin = documents.find((d) => d.title === "Information Bulletin 2027");
    assert.ok(bulletin.matchedSignals.some((s) => s.signal.startsWith("text:")));
  });

  it("7. adapter docRules boost relevant URLs without exam logic", () => {
    const html =
      "<html><body><a href=\"/docs/IB-2027-final.pdf\">Link</a><a href=\"/other.html\">Other</a></body></html>";
    const without = discoverDocumentsFromPages(verifiedSource(), [{ url: "http://127.0.0.1/", html }]);
    assert.equal(without.documents.length, 0);
    const withRules = discoverDocumentsFromPages(verifiedSource(), [{ url: "http://127.0.0.1/", html }], {
      adapterDocRules: [{ label: "information-bulletin", match: [], matchUrl: ["ib-2027"], type: "PDF" }],
    });
    assert.equal(withRules.documents.length, 1);
    assert.equal(withRules.documents[0].label, "OTHER");
    assert.equal(withRules.documents[0].documentType, "PDF");
    assert.ok(withRules.documents[0].matchedSignals.some((s) => s.signal === "adapter-docrule:information-bulletin"));
  });

  it("8. discovered documents carry no extracted exam fields", () => {
    const { documents } = discoverDocumentsFromPages(verifiedSource(), [
      { url: "http://127.0.0.1/", html: LANDING_HTML, depth: 0 },
    ]);
    for (const doc of documents) {
      for (const key of ["registration", "eligibility", "syllabus", "startDate", "endDate", "minLevel", "excerpt"]) {
        assert.ok(!(key in doc), `no extracted field "${key}"`);
      }
    }
  });
});

describe("STEP 4 — bounded traversal", () => {
  const HUB = "http://127.0.0.1/hub.html";
  const LEAF = "http://127.0.0.1/leaf-notice.html";
  const PAGES = {
    "http://127.0.0.1/": {
      url: "http://127.0.0.1/",
      text:
        "<html><body><a href=\"/docs/bulletin.pdf\">Information Bulletin</a>" +
        `<a href=\"${HUB}\">Examination Notifications Hub</a></body></html>`,
    },
    [HUB]: {
      url: HUB,
      text: `<html><body><a href=\"${LEAF}\">Revised Schedule Notification</a></body></html>`,
    },
    [LEAF]: { url: LEAF, text: "<html><body><p>leaf</p></body></html>" },
  };
  const stubFetch = async (url) => {
    if (!PAGES[url]) throw new Error(`unexpected fetch ${url}`);
    return PAGES[url];
  };
  const source = verifiedSource();

  it("9. maxDepth bounds traversal (leaf visible only when deep enough)", async () => {
    const shallow = await discoverFromSource(source, { fetchPage: stubFetch, maxDepth: 0 });
    assert.ok(!shallow.documents.some((d) => d.url === LEAF));
    assert.ok(shallow.documents.some((d) => d.url === HUB));
    const deep = await discoverFromSource(source, { fetchPage: stubFetch, maxDepth: 1 });
    const leaf = deep.documents.find((d) => d.url === LEAF);
    assert.ok(leaf, "leaf discovered at depth 1");
    assert.equal(leaf.depth, 2);
    assert.equal(deep.stats.pagesVisited, 2);
  });

  it("10. maxPages and maxDocuments cap the work", async () => {
    const pages = await discoverFromSource(source, { fetchPage: stubFetch, maxDepth: 5, maxPages: 1 });
    assert.equal(pages.stats.pagesVisited, 1);
    const docs = await discoverFromSource(source, { fetchPage: stubFetch, maxDepth: 5, maxDocuments: 1 });
    assert.equal(docs.documents.length, 1);
  });

  it("11. sameDomainOnly contains traversal; disabling keeps cross-domain docs", async () => {
    const fetchPage = async (url) => {
      if (url === "http://127.0.0.1/") {
        return { url, text: "<html><body><a href=\"https://cdn.example.org/notice.pdf\">External Notice</a></body></html>" };
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const contained = await discoverFromSource(source, { fetchPage, sameDomainOnly: true });
    assert.equal(contained.documents.length, 0);
    const open = await discoverFromSource(source, { fetchPage, sameDomainOnly: false });
    assert.equal(open.documents.length, 1);
    assert.equal(open.documents[0].url, "https://cdn.example.org/notice.pdf");
  });

  it("12. default fetcher path works against a local server", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(LANDING_HTML);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const { documents } = await discoverFromSource(
        { sourceUrl: `${base}/`, sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
        { maxDepth: 0 }
      );
      assert.ok(documents.some((d) => d.label === "BULLETIN"));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("STEP 4 — verification gating and boundaries", () => {
  it("13. SOURCE_REVIEW_REQUIRED sources are refused", async () => {
    const source = verifiedSource({ verificationStatus: "SOURCE_REVIEW_REQUIRED" });
    assert.throws(
      () => discoverDocumentsFromPages(source, [{ url: "http://127.0.0.1/", html: LANDING_HTML }]),
      /only SOURCE_VERIFIED/
    );
    await assert.rejects(
      discoverFromSource(source, { fetchPage: async () => ({ url: "http://127.0.0.1/", text: "" }) }),
      /only SOURCE_VERIFIED/
    );
  });

  it("14. discovery performs no fetching, crawling infra, or publishing", () => {
    const code = fs.readFileSync(path.join(__dirname, "..", "discovery", "documentDiscovery.js"), "utf8");
    assert.ok(!/crawlee/i.test(code.replace(/\/\/.*$/gm, "")), "no Crawlee dependency");
    assert.ok(!/publish/i.test(code.replace(/\/\/.*$/gm, "")), "no publishing");
    // The only network touchpoint is the injectable page fetcher (default:
    // the existing httpFetcher); nothing here launches browsers or queues.
    assert.ok(!/playwright|chromium|RequestQueue/i.test(code));
  });

  it("15. discovery carries no exam-specific logic or names", () => {
    const code = fs.readFileSync(path.join(__dirname, "..", "discovery", "documentDiscovery.js"), "utf8");
    const executable = code
      .replace(/\/\/.*$/gm, "")
      .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "");
    assert.ok(
      !/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b|\bguwahati\b|\broorkee\b/i.test(executable),
      "no exam, board, body, or city names in logic"
    );
    assert.ok(
      !/\bif\b[^\n]*(jee|gate|neet|upsc|nta|iit|nic\.in|gov\.in|guwahati|roorkee)/i.test(code),
      "no branching on any exam, board, or host"
    );
  });
});
