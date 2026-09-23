// =============================================================================
// scraper/tests/crawleeTransport.test.js
// =============================================================================
// WHAT: STEP 1 tests — Crawlee transport beside the existing fetchers.
//   Covers mode selection (off default/shadow resilience/on), static HTML,
//   browser HTML, retry, timeout, duplicate-URL dedup, PDF download handling
//   (static + browser), clean shutdown/isolation, and adapter-genericity.
// WHY: Locks the shadow-evaluation contract: default path unchanged, Crawlee
//   transport generic (no exam names), failures isolated, dedup intentional.
// DB: none — transport has no MongoDB I/O. Local HTTP servers only.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");

const {
  TRANSPORT_MODES,
  getTransportMode,
  crawlOptsOf,
  fetchPageViaCrawlee,
  fetchBinaryViaCrawlee,
  fetchPdfViaBrowserCrawlee,
  crawlViaCrawlee,
  runWithTransport,
} = require("../fetchers/crawleeTransport");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("STEP 1 — crawleeTransport mode selection", () => {
  it("1. default is off; unknown values fall back to off", () => {
    assert.equal(getTransportMode({}), "off");
    assert.equal(getTransportMode({ CRAWLEE_TRANSPORT: undefined }), "off");
    assert.equal(getTransportMode({ CRAWLEE_TRANSPORT: "off" }), "off");
    assert.equal(getTransportMode({ CRAWLEE_TRANSPORT: "shadow" }), "shadow");
    assert.equal(getTransportMode({ CRAWLEE_TRANSPORT: "on" }), "on");
    assert.equal(getTransportMode({ CRAWLEE_TRANSPORT: "SHADOW" }), "shadow");
    assert.equal(getTransportMode({ CRAWLEE_TRANSPORT: "crawlee!!!" }), "off");
    assert.deepEqual([...TRANSPORT_MODES].sort(), ["off", "on", "shadow"]);
  });

  it("2. off runs current only; on runs crawlee only", async () => {
    let currentCalls = 0;
    let crawleeCalls = 0;
    const current = async () => {
      currentCalls += 1;
      return "current-result";
    };
    const crawlee = async () => {
      crawleeCalls += 1;
      return "crawlee-result";
    };
    const off = await runWithTransport({ mode: "off", current, crawlee });
    assert.equal(off.primary, "current");
    assert.equal(off.result, "current-result");
    assert.equal(crawleeCalls, 0);

    const on = await runWithTransport({ mode: "on", current, crawlee });
    assert.equal(on.primary, "crawlee");
    assert.equal(on.result, "crawlee-result");
    assert.equal(currentCalls, 1);
  });

  it("3. shadow keeps the primary result when Crawlee fails", async () => {
    const current = async () => "primary-ok";
    const failing = async () => {
      throw new Error("shadow boom");
    };
    const out = await runWithTransport({ mode: "shadow", current, crawlee: failing });
    assert.equal(out.primary, "current");
    assert.equal(out.result, "primary-ok");
    assert.equal(out.shadow.ok, false);
    assert.match(out.shadow.error, /shadow boom/);

    const passing = async () => "shadow-ok";
    const out2 = await runWithTransport({ mode: "shadow", current, crawlee: passing });
    assert.equal(out2.shadow.ok, true);
    assert.equal(out2.shadow.result, "shadow-ok");
  });

  it("4. crawl options mirror adapter.crawl with current defaults", () => {
    assert.deepEqual(crawlOptsOf({}, false), { timeout: 15000, retries: 2, delay: 0 });
    assert.deepEqual(crawlOptsOf({}, true), { timeout: 30000, retries: 2, delay: 0 });
    assert.deepEqual(
      crawlOptsOf({ crawl: { timeoutMs: 5000, maxRetries: 1, requestDelayMs: 250 } }, false),
      { timeout: 5000, retries: 1, delay: 250 }
    );
  });
});

describe("STEP 1 — crawleeTransport fetching", () => {
  it("5. static HTML fetch returns text + status", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>static</title></head><body><p>static body</p></body></html>");
    });
    const base = await listen(server);
    try {
      const page = await fetchPageViaCrawlee(`${base}/`, { timeout: 10000, retries: 0 });
      assert.equal(page.status, 200);
      assert.ok(page.text.includes("static body"));
      assert.equal(page.stats.requests, 1);
      assert.equal(page.stats.finished, 1);
    } finally {
      await close(server);
    }
  });

  it("6. browser HTML fetch returns rendered text + status", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>pw</title></head><body><p>browser body</p></body></html>");
    });
    const base = await listen(server);
    try {
      const page = await fetchPageViaCrawlee(`${base}/`, { timeout: 30000, retries: 0, useBrowser: true });
      assert.equal(page.status, 200);
      assert.ok(page.text.includes("browser body"));
    } finally {
      await close(server);
    }
  });

  it("7. retry recovers after transient 500s", async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      if (hits <= 2) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("boom");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><p>recovered</p></body></html>");
    });
    const base = await listen(server);
    try {
      const page = await fetchPageViaCrawlee(`${base}/flaky`, { timeout: 10000, retries: 3 });
      assert.equal(page.status, 200);
      assert.ok(page.text.includes("recovered"));
      assert.equal(hits, 3);
    } finally {
      await close(server);
    }
  });

  it("8. timeout fails fast with a clear error", async () => {
    const sockets = new Set();
    const server = http.createServer(() => {
      // Hangs: only the client timeout ends this request.
    });
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    await listen(server);
    const url = `http://127.0.0.1:${server.address().port}/hang`;
    const started = Date.now();
    try {
      await assert.rejects(
        fetchPageViaCrawlee(url, { timeout: 800, retries: 0 }),
        /crawleeTransport: GET .* failed/
      );
      assert.ok(Date.now() - started < 30000, "must not hang");
    } finally {
      for (const s of sockets) s.destroy();
      await close(server);
    }
  });

  it("9. duplicate URLs are deduped at the request queue", async () => {
    const perPath = {};
    const server = http.createServer((req, res) => {
      perPath[req.url] = (perPath[req.url] || 0) + 1;
      res.writeHead(200, { "Content-Type": "text/html" });
      if (req.url === "/") {
        res.end('<html><head><title>t</title></head><body><a href="/shared.html">Shared document</a></body></html>');
      } else {
        res.end("<html><head><title>s</title></head><body><p>shared</p></body></html>");
      }
    });
    const base = await listen(server);
    try {
      const adapter = {
        slug: "step1-dupe",
        startUrls: [`${base}/`],
        render: "static",
        docRules: [
          { label: "copy-a", match: ["shared document"] },
          { label: "copy-b", match: ["shared"] },
        ],
      };
      const { raws, stats } = await crawlViaCrawlee(adapter);
      assert.equal(perPath["/shared.html"], 1);
      assert.equal(stats.dedupSkipped, 1);
      assert.equal(raws.length, 1);
    } finally {
      await close(server);
    }
  });

  it("10. static PDF bytes round-trip byte-identical", async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xaa, 0xbb]);
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(bytes);
    });
    const base = await listen(server);
    try {
      const res = await fetchBinaryViaCrawlee(`${base}/f.pdf`, { timeout: 10000, retries: 0 });
      assert.equal(res.status, 200);
      assert.ok(Buffer.isBuffer(res.buffer));
      assert.ok(res.buffer.equals(bytes));
      assert.equal(res.contentType, "application/pdf");
    } finally {
      await close(server);
    }
  });

  it("11. browser PDF download is captured byte-identical", async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xaa, 0xbb, 0xcc]);
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(bytes);
    });
    const base = await listen(server);
    try {
      const res = await fetchPdfViaBrowserCrawlee(`${base}/f.pdf`, { timeout: 30000, retries: 0 });
      assert.ok(Buffer.isBuffer(res.buffer));
      assert.ok(res.buffer.equals(bytes));
      assert.equal(res.via, "browser-download");
    } finally {
      await close(server);
    }
  });

  it("12. adapter crawl keeps the crawlSource shape (landing + raws)", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      if (req.url === "/") {
        res.end(
          "<html><head><title>gate</title></head><body>" +
            '<a href="/elig.html">Eligibility Criteria</a>' +
            '<a href="/dates.html">Important Dates</a></body></html>'
        );
      } else {
        res.end("<html><head><title>doc</title></head><body><p>doc body text</p></body></html>");
      }
    });
    const base = await listen(server);
    try {
      const adapter = {
        slug: "step1-shape",
        startUrls: [`${base}/`],
        render: "static",
        docRules: [
          { label: "eligibility", match: ["eligibility criteria"], type: "HTML" },
          { label: "important-dates", match: ["important dates"], type: "HTML" },
        ],
      };
      const { landing, raws, stats } = await crawlViaCrawlee(adapter);
      assert.ok(landing.url.startsWith("http://127.0.0.1"));
      assert.equal(landing.status, 200);
      assert.equal(raws.length, 2);
      assert.deepEqual(
        raws.map((r) => r.label).sort(),
        ["eligibility", "important-dates"]
      );
      for (const r of raws) {
        assert.equal(typeof r.url, "string");
        assert.equal(typeof r.sourceUrl, "string");
        assert.ok(r.fetchedAt instanceof Date);
        assert.equal(typeof r.content, "string");
      }
      assert.equal(stats.failed, 0);
    } finally {
      await close(server);
    }
  });

  it("13. storage stays outside the repo and runs resolve cleanly", async () => {
    const storageDir = process.env.CRAWLEE_STORAGE_DIR;
    const repoRoot = path.join(__dirname, "..");
    if (storageDir) {
      assert.ok(!path.resolve(storageDir).startsWith(path.resolve(repoRoot) + path.sep));
    }
    // A second consecutive run must work (isolation between runs).
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><p>again</p></body></html>");
    });
    const base = await listen(server);
    try {
      for (let i = 0; i < 2; i += 1) {
        const page = await fetchPageViaCrawlee(`${base}/`, { timeout: 10000, retries: 0 });
        assert.ok(page.text.includes("again"));
      }
    } finally {
      await close(server);
    }
  });

  it("14. transport carries no exam-specific logic", () => {
    const code = fs.readFileSync(path.join(__dirname, "..", "fetchers", "crawleeTransport.js"), "utf8");
    const executable = code.replace(/\/\/.*$/gm, "");
    assert.ok(
      !/jee-main|jee-advanced|gate-2026|\bnta\b|\biitg?\b|roorkee|guwahati/i.test(executable),
      "transport must not name exams or boards"
    );
  });
});
