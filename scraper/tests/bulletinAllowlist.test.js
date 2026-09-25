// =============================================================================
// scraper/tests/bulletinAllowlist.test.js
// =============================================================================
// WHAT: STEP 22 tests — adapter-declared exact bulletin URLs: probed exactly
//   as declared (never generated), bounded, validated like any document,
//   routed through the existing render-aware transport, attempted only after
//   normal discovery and the Step 21 fallback yield no bulletin, with
//   failures isolated per URL.
// WHY: The allowlist is explicit operator trust, not a crawler: declaration
//   is the only source of candidate URLs, and a 200 alone never validates.
// DB: none — local HTTP servers and injected stubs only.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");

const { MAX_BULLETIN_URLS, SourceAdapterConfigSchema } = require("../registry/schema");
const {
  needsAllowlistProbe,
  probeAllowlistUrls,
} = require("../discovery/bulletinFallback");

const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xaa, 0xbb]);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function stubFetchDocument(byUrl) {
  return async (meta) => {
    if (!Object.prototype.hasOwnProperty.call(byUrl, meta.url)) {
      throw new Error(`unexpected fetch ${meta.url}`);
    }
    const hit = byUrl[meta.url];
    if (hit.error) throw new Error(hit.error);
    return {
      label: meta.label,
      url: meta.url,
      sourceUrl: meta.sourceUrl,
      type: hit.type,
      fetchedAt: new Date("2026-01-01T00:00:00Z"),
      status: hit.status || 200,
      contentType: hit.contentType,
      content: hit.content,
    };
  };
}

describe("STEP 22 — adapter-declared bulletin allowlist", () => {
  it("1. schema bounds the declaration; adapters default to empty", () => {
    assert.equal(MAX_BULLETIN_URLS, 5);
    const base = {
      slug: "step22-test",
      name: "Step22",
      fullForm: "Step Twenty Two",
      conductingBody: "Step Twenty Two Board",
      officialWebsite: "http://127.0.0.1/",
      startUrls: ["http://127.0.0.1/"],
    };
    assert.deepEqual(SourceAdapterConfigSchema.parse(base).bulletinUrls, []);
    const one = SourceAdapterConfigSchema.parse({ ...base, bulletinUrls: ["http://127.0.0.1/b.pdf"] });
    assert.deepEqual(one.bulletinUrls, ["http://127.0.0.1/b.pdf"]);
    assert.equal(
      SourceAdapterConfigSchema.safeParse({ ...base, bulletinUrls: ["not-a-url"] }).success,
      false
    );
    assert.equal(
      SourceAdapterConfigSchema.safeParse({
        ...base,
        bulletinUrls: Array.from({ length: MAX_BULLETIN_URLS + 1 }, (_, i) => `http://127.0.0.1/${i}.pdf`),
      }).success,
      false
    );
  });

  it("2. declared URLs are probed exactly — no variants generated", async () => {
    const attempted = [];
    const fetchDocument = async (meta) => {
      attempted.push(meta.url);
      return stubFetchDocument({ "http://127.0.0.1/exact.pdf": { type: "PDF", contentType: "application/pdf", content: PDF_BYTES } })(meta);
    };
    const out = await probeAllowlistUrls(
      {
        source: { sourceUrl: "http://127.0.0.1/", sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
        adapter: { slug: "x", render: "static", bulletinUrls: ["http://127.0.0.1/exact.pdf"], docRules: [] },
        options: { fetchDocument },
      }
    );
    assert.deepEqual(attempted, ["http://127.0.0.1/exact.pdf"]);
    assert.equal(out.accepted.length, 1);
    assert.equal(out.probed[0].derivedFrom, "adapter-allowlist");
    assert.equal(out.probed[0].pattern, "exact-declared-url");
    assert.equal(out.probed[0].reachable, true);
    assert.equal(out.probed[0].accepted, true);
    assert.equal(out.probed[0].bytes, PDF_BYTES.length);
  });

  it("3. declared count beyond the bound is truncated deterministically", async () => {
    const attempted = [];
    const urls = Array.from({ length: MAX_BULLETIN_URLS + 2 }, (_, i) => `http://127.0.0.1/${i}.pdf`);
    const byUrl = Object.fromEntries(
      urls.map((url) => [url, { type: "PDF", contentType: "application/pdf", content: PDF_BYTES }])
    );
    const out = await probeAllowlistUrls({
      source: { sourceUrl: "http://127.0.0.1/", sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
      adapter: { slug: "x", render: "static", bulletinUrls: urls, docRules: [] },
      options: {
        fetchDocument: async (meta) => {
          attempted.push(meta.url);
          return stubFetchDocument(byUrl)(meta);
        },
      },
    });
    assert.equal(attempted.length, MAX_BULLETIN_URLS);
    assert.deepEqual(attempted, urls.slice(0, MAX_BULLETIN_URLS));
    assert.equal(out.accepted.length, MAX_BULLETIN_URLS);
  });

  it("4. invalid documents are rejected even when declared", async () => {
    const out = await probeAllowlistUrls({
      source: { sourceUrl: "http://127.0.0.1/", sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
      adapter: { slug: "x", render: "static", bulletinUrls: ["http://127.0.0.1/junk.pdf", "http://127.0.0.1/page.html"], docRules: [] },
      options: {
        fetchDocument: stubFetchDocument({
          "http://127.0.0.1/junk.pdf": { type: "PDF", contentType: "text/html", content: Buffer.from("not a pdf at all") },
          "http://127.0.0.1/page.html": { type: "HTML", contentType: "text/html", content: "<html><body>generic</body></html>" },
        }),
      },
    });
    assert.equal(out.accepted.length, 0);
    assert.equal(out.probed.length, 2);
    assert.ok(out.probed.every((entry) => entry.reachable && !entry.accepted));
  });

  it("5. failures are isolated per URL and never throw", async () => {
    const out = await probeAllowlistUrls({
      source: { sourceUrl: "http://127.0.0.1/", sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
      adapter: { slug: "x", render: "static", bulletinUrls: ["http://127.0.0.1/down.pdf", "http://127.0.0.1/ok.pdf"], docRules: [] },
      options: {
        fetchDocument: stubFetchDocument({
          "http://127.0.0.1/ok.pdf": { type: "PDF", contentType: "application/pdf", content: PDF_BYTES },
        }),
      },
    });
    // "down.pdf" has no stub entry: the stub throws (like a network failure).
    assert.equal(out.accepted.length, 1);
    const down = out.probed.find((entry) => entry.url.endsWith("/down.pdf"));
    assert.equal(down.reachable, false);
    assert.match(down.reason, /fetch failed/);
  });

  it("6. cleartext off-loopback and unparseable declarations are refused without fetching", async () => {
    let calls = 0;
    const out = await probeAllowlistUrls({
      source: { sourceUrl: "http://127.0.0.1/", sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
      adapter: { slug: "x", render: "static", bulletinUrls: ["http://127.0.0.1/plain.pdf", "http://[invalid"], docRules: [] },
      options: {
        fetchDocument: async (meta) => {
          calls += 1;
          return stubFetchDocument({ "http://127.0.0.1/plain.pdf": { type: "PDF", contentType: "application/pdf", content: PDF_BYTES } })(meta);
        },
      },
    });
    assert.equal(calls, 1);
    const bad = out.probed.find((entry) => entry.url === "http://[invalid");
    assert.equal(bad.reachable, false);
    assert.match(bad.reason, /not parseable/);
    const cleartext = await probeAllowlistUrls({
      source: { sourceUrl: "http://127.0.0.1/", sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
      adapter: { slug: "x", render: "static", bulletinUrls: ["http://example.com/b.pdf"], docRules: [] },
      options: {
        fetchDocument: async () => {
          throw new Error("must not fetch cleartext off-loopback");
        },
      },
    });
    assert.equal(cleartext.accepted.length, 0);
    assert.match(cleartext.probed[0].reason, /must use https/);
  });

  it("7. precedence: allowlist runs only while no bulletin exists", () => {
    const adapter = { slug: "x", render: "js", bulletinUrls: ["http://127.0.0.1/b.pdf"], docRules: [] };
    assert.equal(needsAllowlistProbe({ documents: [], fallbackAccepted: [], adapter }), true);
    assert.equal(
      needsAllowlistProbe({
        documents: [{ label: "BULLETIN", url: "http://127.0.0.1/a.pdf", matchedSignals: [] }],
        fallbackAccepted: [],
        adapter,
      }),
      false
    );
    assert.equal(
      needsAllowlistProbe({
        documents: [{ label: "OTHER", url: "http://127.0.0.1/x.pdf", matchedSignals: [{ signal: "adapter-docrule:information-bulletin" }] }],
        fallbackAccepted: [],
        adapter,
      }),
      false
    );
    assert.equal(
      needsAllowlistProbe({
        documents: [{ label: "NOTIFICATION", url: "http://127.0.0.1/n.html", matchedSignals: [] }],
        fallbackAccepted: [{ url: "http://127.0.0.1/f.pdf" }],
        adapter,
      }),
      false
    );
    assert.equal(
      needsAllowlistProbe({ documents: [], fallbackAccepted: [], adapter: { slug: "y", render: "static", bulletinUrls: ["https://127.0.0.1/b.pdf"] } }),
      true,
      "gating is about missing bulletins, not render mode"
    );
    assert.equal(needsAllowlistProbe({ documents: [], fallbackAccepted: [], adapter: { slug: "y", render: "static", bulletinUrls: [] } }), false);
    assert.equal(needsAllowlistProbe({ documents: [], fallbackAccepted: [], adapter: { slug: "y", render: "static" } }), false);
    assert.equal(needsAllowlistProbe({ documents: [], fallbackAccepted: [] }), false);
  });

  it("8. js adapters fetch declared PDFs via browser; static via HTTP", async () => {
    const uas = [];
    const server = http.createServer((req, res) => {
      uas.push(req.headers["user-agent"] || null);
      if (req.url === "/b.pdf") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end(PDF_BYTES);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><p>landing</p></body></html>");
    });
    const base = await listen(server);
    try {
      const jsOut = await probeAllowlistUrls(
        {
          source: { sourceUrl: `${base}/`, sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
          adapter: { slug: "x", render: "js", bulletinUrls: [`${base}/b.pdf`], docRules: [] },
        },
        { maxCandidates: 1 }
      );
      assert.equal(jsOut.accepted.length, 1);
      assert.ok(jsOut.accepted[0].content.equals(PDF_BYTES));
      assert.ok(uas.length > 0 && uas.every((ua) => ua && !ua.includes("NextStepScraper")), `browser traffic expected, got: ${uas}`);

      uas.length = 0;
      const staticOut = await probeAllowlistUrls(
        {
          source: { sourceUrl: `${base}/`, sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
          adapter: { slug: "y", render: "static", bulletinUrls: [`${base}/b.pdf`], docRules: [] },
        },
        { maxCandidates: 1 }
      );
      assert.equal(staticOut.accepted.length, 1);
      assert.ok(uas.length > 0 && uas.every((ua) => ua && ua.includes("NextStepScraper")), `plain HTTP expected, got: ${uas}`);
    } finally {
      await close(server);
    }
  });

  it("9. allowlist carries no exam-specific logic and guesses nothing", () => {
    const code = fs.readFileSync(path.join(__dirname, "..", "discovery", "bulletinFallback.js"), "utf8");
    const executable = code
      .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
      .replace(/\/\/.*$/gm, "");
    assert.ok(
      !/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable),
      "allowlist must not name exams or boards"
    );
    assert.ok(!/\bif\b[^\n]*(jee|gate|neet|upsc|nta|iit|nic\.in|gov\.in)/i.test(code));
    assert.ok(!/\/bulletin\.pdf|\/information-bulletin\.pdf|\/uploads\//i.test(code), "no hardcoded bulletin paths");
  });
});
