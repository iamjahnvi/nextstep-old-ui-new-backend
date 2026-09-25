// =============================================================================
// scraper/tests/transportSelection.test.js
// =============================================================================
// WHAT: STEP 20 tests — render-aware transport selection. Static adapters
//   keep the existing HTTP path byte-for-byte; render "js" adapters fetch
//   pages through the pooled browser and PDFs through the browser download
//   capture; failures stay controlled and per-request.
// WHY: Discovery and ingestion used to default to HTTP unconditionally, so a
//   js adapter could never reach its configured transport. Selection is proven
//   here by User-Agent discrimination on a local server (plain HTTP client
//   identifies as NextStepScraper; browser traffic never does), plus shape
//   and failure assertions — no live network.
// DB: none — local HTTP servers only.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");

const {
  isBrowserAdapter,
  fetchPageForAdapter,
  fetchDocumentForAdapter,
} = require("../fetchers/transportSelector");
const { discoverFromSource } = require("../discovery/documentDiscovery");

const STATIC_ADAPTER = { slug: "step20-static", render: "static" };
const JS_ADAPTER = { slug: "step20-js", render: "js" };

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("STEP 20 — render-aware transport selection", () => {
  it("1. render flag alone selects the transport family", () => {
    assert.equal(isBrowserAdapter({ render: "js" }), true);
    assert.equal(isBrowserAdapter({ render: "static" }), false);
    assert.equal(isBrowserAdapter(undefined), false);
    assert.equal(isBrowserAdapter(null), false);
    assert.equal(isBrowserAdapter({}), false);
  });

  it("2. static adapter keeps the existing HTTP path verbatim", async () => {
    let observedUa = null;
    const server = http.createServer((req, res) => {
      observedUa = req.headers["user-agent"] || null;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>static</title></head><body><p>static body</p></body></html>");
    });
    const base = await listen(server);
    try {
      const page = await fetchPageForAdapter(`${base}/`, STATIC_ADAPTER);
      assert.deepEqual(Object.keys(page).sort(), ["status", "text", "url"]);
      assert.equal(page.status, 200);
      assert.ok(page.text.includes("static body"));
      assert.ok(observedUa && observedUa.includes("NextStepScraper"), `plain HTTP client expected, got: ${observedUa}`);
      assert.ok(!("transport" in page));
    } finally {
      await close(server);
    }
  });

  it("3. js adapter fetches pages through the browser transport", async () => {
    let observedUa = null;
    const server = http.createServer((req, res) => {
      observedUa = req.headers["user-agent"] || null;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>js</title></head><body><p>browser body</p></body></html>");
    });
    const base = await listen(server);
    try {
      const page = await fetchPageForAdapter(`${base}/`, JS_ADAPTER, { timeout: 30000, retries: 0 });
      assert.equal(page.status, 200);
      assert.ok(page.text.includes("browser body"));
      assert.equal(page.transport, "browser");
      assert.ok(observedUa && !observedUa.includes("NextStepScraper"), `browser traffic expected, got: ${observedUa}`);
      assert.ok(/Chrome/.test(observedUa), `Chromium UA expected, got: ${observedUa}`);
    } finally {
      await close(server);
    }
  });

  it("4. static documents keep existing shapes; js PDFs capture bytes", async () => {
    const pdfBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xaa, 0xbb]);
    const server = http.createServer((req, res) => {
      if (req.url === "/f.pdf") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end(pdfBytes);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><p>doc body</p></body></html>");
    });
    const base = await listen(server);
    try {
      const html = await fetchDocumentForAdapter(
        { label: "page", url: `${base}/p.html`, sourceUrl: `${base}/`, type: "HTML" },
        STATIC_ADAPTER
      );
      assert.equal(html.type, "HTML");
      assert.equal(typeof html.content, "string");
      assert.ok(html.content.includes("doc body"));
      assert.ok(!("transport" in html));

      const pdf = await fetchDocumentForAdapter(
        { label: "doc", url: `${base}/f.pdf`, sourceUrl: `${base}/`, type: "PDF" },
        STATIC_ADAPTER
      );
      assert.equal(pdf.type, "PDF");
      assert.ok(Buffer.isBuffer(pdf.content) && pdf.content.equals(pdfBytes));

      const jsPdf = await fetchDocumentForAdapter(
        { label: "doc", url: `${base}/f.pdf`, sourceUrl: `${base}/`, type: "PDF" },
        JS_ADAPTER
      );
      assert.equal(jsPdf.type, "PDF");
      assert.equal(jsPdf.transport, "browser");
      assert.ok(Buffer.isBuffer(jsPdf.content) && jsPdf.content.equals(pdfBytes));
      assert.equal(jsPdf.contentType, "application/pdf");
    } finally {
      await close(server);
    }
  });

  it("5. discovery defaults follow the adapter when no fetchPage is injected", async () => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push(req.headers["user-agent"] || null);
      res.writeHead(200, { "Content-Type": "text/html" });
      if (req.url === "/") {
        res.end('<html><body><a href="/bulletin-2027.pdf">Information Bulletin 2027</a></body></html>');
      } else {
        res.end("<html><body><p>other</p></body></html>");
      }
    });
    const base = await listen(server);
    try {
      const viaStatic = await discoverFromSource(
        { sourceUrl: `${base}/`, sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
        { adapter: STATIC_ADAPTER, maxDepth: 0, maxPages: 1 }
      );
      assert.ok(viaStatic.documents.length >= 1);
      assert.ok(hits.every((ua) => ua && ua.includes("NextStepScraper")));

      hits.length = 0;
      const viaJs = await discoverFromSource(
        { sourceUrl: `${base}/`, sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
        { adapter: JS_ADAPTER, maxDepth: 0, maxPages: 1 }
      );
      assert.ok(viaJs.documents.length >= 1);
      assert.ok(hits.length > 0 && hits.every((ua) => ua && !ua.includes("NextStepScraper")));
    } finally {
      await close(server);
    }
  });

  it("6. an explicit fetchPage still wins over adapter selection", async () => {
    let stubCalls = 0;
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<html><body><a href="/x.pdf">Information Bulletin X</a></body></html>');
    });
    const base = await listen(server);
    try {
      const out = await discoverFromSource(
        { sourceUrl: `${base}/`, sourceDomain: "127.0.0.1", verificationStatus: "SOURCE_VERIFIED" },
        {
          adapter: JS_ADAPTER,
          maxDepth: 0,
          maxPages: 1,
          fetchPage: async (url) => {
            stubCalls += 1;
            return { url, text: '<html><body><a href="/y.pdf">Information Bulletin Y</a></body></html>' };
          },
        }
      );
      assert.equal(stubCalls, 1);
      assert.ok(out.documents.some((doc) => doc.url.endsWith("/y.pdf")));
    } finally {
      await close(server);
    }
  });

  it("7. transport failures are controlled and per-request", async () => {
    await assert.rejects(
      fetchDocumentForAdapter({ label: "x" }, STATIC_ADAPTER),
      /transportSelector: discovered document has no url/
    );
    await assert.rejects(
      fetchPageForAdapter("http://127.0.0.1:1/unreachable", JS_ADAPTER, { timeout: 2000, retries: 0 }),
      /crawleeTransport: GET .* failed/
    );
    await assert.rejects(
      fetchDocumentForAdapter(
        { label: "x", url: "http://127.0.0.1:1/nope.pdf", sourceUrl: "http://127.0.0.1/", type: "PDF" },
        JS_ADAPTER,
        { timeout: 2000, retries: 0 }
      ),
      /crawleeTransport: GET .* failed/
    );
  });

  it("8. selector carries no exam-specific logic", () => {
    const code = fs.readFileSync(path.join(__dirname, "..", "fetchers", "transportSelector.js"), "utf8");
    const executable = code
      .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
      .replace(/\/\/.*$/gm, "");
    assert.ok(
      !/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable),
      "selector must not name exams or boards"
    );
    assert.ok(!/\bif\b[^\n]*(jee|gate|neet|upsc|nta|iit|nic\.in|gov\.in)/i.test(code));
  });
});
