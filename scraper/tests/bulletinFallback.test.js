// =============================================================================
// scraper/tests/bulletinFallback.test.js
// =============================================================================
// WHAT: STEP 21 tests — observed-only bulletin fallback. Normal discovery
//   winning suppresses the fallback; missing bulletins on js adapters derive
//   deterministic candidates from observed page links only; unreachable
//   candidates fail closed per entry; attempts stay bounded; static adapters
//   never trigger it.
// WHY: A js landing can render fine while its bulletin link escapes scoring.
//   The fallback closes exactly that gap — no constructed paths, no second
//   crawler, no behavior change for static flows.
// DB: none — local HTTP servers and injected stubs only.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");

const {
  DEFAULT_MAX_CANDIDATES,
  needsBulletinFallback,
  deriveBulletinCandidates,
  probeBulletinFallback,
} = require("../discovery/bulletinFallback");

const JS_ADAPTER = {
  slug: "step21-js",
  render: "js",
  docRules: [{ label: "information-bulletin", match: ["information bulletin"], type: "PDF" }],
};
const STATIC_ADAPTER = { slug: "step21-static", render: "static" };

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xaa, 0xbb]);

describe("STEP 21 — bulletin fallback gating and derivation", () => {
  it("1. normal discovery winning suppresses the fallback", () => {
    assert.equal(
      needsBulletinFallback(
        [{ label: "BULLETIN", url: "http://127.0.0.1/b.pdf", matchedSignals: [] }],
        JS_ADAPTER
      ),
      false
    );
    assert.equal(
      needsBulletinFallback(
        [{ label: "OTHER", url: "http://127.0.0.1/x.pdf", matchedSignals: [{ signal: "adapter-docrule:information-bulletin" }] }],
        JS_ADAPTER
      ),
      false
    );
    assert.equal(needsBulletinFallback([], JS_ADAPTER), true);
    assert.equal(
      needsBulletinFallback([{ label: "NOTIFICATION", url: "http://127.0.0.1/n.html", matchedSignals: [] }], JS_ADAPTER),
      true
    );
  });

  it("2. static adapters never trigger the fallback", () => {
    assert.equal(needsBulletinFallback([], STATIC_ADAPTER), false);
    assert.equal(
      needsBulletinFallback([{ label: "OTHER", url: "http://127.0.0.1/x.pdf", matchedSignals: [] }], STATIC_ADAPTER),
      false
    );
    assert.equal(needsBulletinFallback([], undefined), false);
    assert.equal(needsBulletinFallback([], null), false);
  });

  it("3. candidates derive from observed links only, ranked deterministically", () => {
    const links = [
      { text: "Download", url: "/files/doc123.pdf" },
      { text: "Information Bulletin", url: "/files/ib.pdf" },
      { text: "Login", url: "/login" },
      { text: "External", url: "https://cdn.example.org/f.pdf" },
      { text: "About", url: "/about.html" },
    ];
    const first = deriveBulletinCandidates({
      links,
      pageUrl: "http://127.0.0.1/",
      sourceDomain: "127.0.0.1",
      adapterDocRules: JS_ADAPTER.docRules,
      knownUrls: ["http://127.0.0.1/files/ib.pdf"],
    });
    // ib.pdf excluded as already known; "Download" PDF kept; boilerplate,
    // off-domain, and non-PDF-without-rule links excluded.
    assert.deepEqual(first.map((c) => c.url), ["http://127.0.0.1/files/doc123.pdf"]);
    assert.equal(first[0].derivedFrom, "page-link");
    assert.equal(first[0].pattern, "page-pdf-link");
    assert.deepEqual(
      deriveBulletinCandidates({
        links,
        pageUrl: "http://127.0.0.1/",
        sourceDomain: "127.0.0.1",
        adapterDocRules: JS_ADAPTER.docRules,
        knownUrls: [],
      }).map((c) => c.url),
      ["http://127.0.0.1/files/ib.pdf", "http://127.0.0.1/files/doc123.pdf"]
    );
    // Adapter text-match ranks above bare PDF links.
    const ranked = deriveBulletinCandidates({
      links,
      pageUrl: "http://127.0.0.1/",
      sourceDomain: "127.0.0.1",
      adapterDocRules: JS_ADAPTER.docRules,
      knownUrls: [],
    });
    assert.ok(ranked[0].pattern.startsWith("adapter-docrule:"));
    // Deterministic across runs.
    assert.deepEqual(
      deriveBulletinCandidates({
        links,
        pageUrl: "http://127.0.0.1/",
        sourceDomain: "127.0.0.1",
        adapterDocRules: JS_ADAPTER.docRules,
        knownUrls: [],
      }),
      ranked
    );
    assert.throws(() => deriveBulletinCandidates({ links }), /pageUrl is required/);
  });

  it("4. attempts stay within the configured bound", () => {
    const links = Array.from({ length: 8 }, (_, i) => ({ text: "Download", url: `/files/d${i}.pdf` }));
    const out = deriveBulletinCandidates({
      links,
      pageUrl: "http://127.0.0.1/",
      sourceDomain: "127.0.0.1",
      adapterDocRules: [],
      maxCandidates: 2,
    });
    assert.equal(out.length, 2);
    assert.equal(DEFAULT_MAX_CANDIDATES, 3);
  });
});

describe("STEP 21 — fallback probing", () => {
  it("5. reachable valid document is accepted with evidence", async () => {
    const fetchPage = async (url) => ({
      url,
      text: '<html><body><a href="/files/doc123.pdf">Download</a></body></html>',
    });
    const fetchDocument = async (meta) => ({
      label: meta.label,
      url: meta.url,
      sourceUrl: meta.sourceUrl,
      type: "PDF",
      fetchedAt: new Date("2026-01-01T00:00:00Z"),
      status: 200,
      contentType: "application/pdf",
      content: PDF_BYTES,
    });
    const out = await probeBulletinFallback({
      source: { sourceUrl: "http://127.0.0.1/", sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
      adapter: JS_ADAPTER,
      options: { fetchPage, fetchDocument },
    });
    assert.equal(out.probed.length, 1);
    assert.equal(out.probed[0].reachable, true);
    assert.equal(out.probed[0].accepted, true);
    assert.equal(out.probed[0].derivedFrom, "page-link");
    assert.equal(out.probed[0].bytes, PDF_BYTES.length);
    assert.equal(out.accepted.length, 1);
    assert.equal(out.accepted[0].type, "PDF");
    assert.ok(out.accepted[0].content.equals(PDF_BYTES));
  });

  it("6. unreachable or invalid candidates fail closed without crashing", async () => {
    const fetchPage = async (url) => ({
      url,
      text: '<html><body><a href="/files/gone.pdf">Download</a><a href="/files/junk.pdf">Mirror</a></body></html>',
    });
    const fetchDocument = async (meta) => {
      if (meta.url.endsWith("/gone.pdf")) throw new Error("httpFetcher: GET failed (HTTP 404)");
      return {
        label: meta.label,
        url: meta.url,
        sourceUrl: meta.sourceUrl,
        type: "PDF",
        fetchedAt: new Date("2026-01-01T00:00:00Z"),
        status: 200,
        contentType: "text/html",
        content: Buffer.from("not a pdf at all"),
      };
    };
    const out = await probeBulletinFallback({
      source: { sourceUrl: "http://127.0.0.1/", sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
      adapter: JS_ADAPTER,
      options: { fetchPage, fetchDocument },
    });
    assert.equal(out.accepted.length, 0);
    assert.equal(out.probed.length, 2);
    const gone = out.probed.find((p) => p.url.endsWith("/gone.pdf"));
    assert.equal(gone.reachable, false);
    assert.equal(gone.accepted, false);
    assert.match(gone.reason, /fetch failed/);
    const junk = out.probed.find((p) => p.url.endsWith("/junk.pdf"));
    assert.equal(junk.reachable, true);
    assert.equal(junk.accepted, false);
    assert.match(junk.reason, /not a valid PDF/);
  });

  it("7. landing fetch failure is contained, not thrown", async () => {
    const out = await probeBulletinFallback({
      source: { sourceUrl: "http://127.0.0.1/", sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
      adapter: JS_ADAPTER,
      options: {
        fetchPage: async () => {
          throw new Error("connection refused");
        },
      },
    });
    assert.deepEqual(out.accepted, []);
    assert.deepEqual(out.probed, []);
    assert.match(out.error, /landing re-fetch failed/);
  });

  it("8. default transports work end to end on a local server", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/files/doc123.pdf") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end(PDF_BYTES);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<html><body><a href="/files/doc123.pdf">Download</a></body></html>');
    });
    const base = await listen(server);
    try {
      // Static adapter through default transports (existing HTTP path).
      const out = await probeBulletinFallback({
        source: { sourceUrl: `${base}/`, sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
        adapter: STATIC_ADAPTER,
        options: {},
      });
      assert.equal(out.accepted.length, 1);
      assert.ok(out.accepted[0].content.equals(PDF_BYTES));
    } finally {
      await close(server);
    }
  });

  it("9. fallback module carries no exam-specific logic", () => {
    const code = fs.readFileSync(path.join(__dirname, "..", "discovery", "bulletinFallback.js"), "utf8");
    const executable = code
      .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
      .replace(/\/\/.*$/gm, "");
    assert.ok(
      !/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable),
      "fallback must not name exams or boards"
    );
    assert.ok(!/\bif\b[^\n]*(jee|gate|neet|upsc|nta|iit|nic\.in|gov\.in)/i.test(code));
    assert.ok(!/\/bulletin\.pdf|\/information-bulletin\.pdf|\/uploads\//i.test(code), "no hardcoded bulletin paths");
  });
});
