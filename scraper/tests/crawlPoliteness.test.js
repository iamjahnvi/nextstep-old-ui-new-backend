// =============================================================================
// scraper/tests/crawlPoliteness.test.js
// =============================================================================
// WHAT: Phase 20 tests — per-adapter crawl configuration (delay, timeout,
//   retries) validated by schema and honored by the fetch/retrieval layer.
// WHY: Locks polite, bounded crawling per source: unset values keep fetcher
//   defaults (existing behavior), set values actually reach the requests,
//   and unsafe values fail validation instead of misbehaving.
// DB: one isolated mongodb-memory-server for the ingestion delay test;
//   fetch-level tests use local HTTP servers only. Production MONGO_URI unset.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");

const { SourceAdapterConfigSchema } = require("../registry/schema");
const {
  fetchDocument,
  crawlFetchOptions,
  crawlDelayMs,
} = require("../fetchers/documentFetcher");
const { runIngestionPipeline } = require("../pipeline/ingestionPipeline");
const jeeAdapter = require("../registry/exams/jee-main");
const gateAdapter = require("../registry/exams/gate-2026");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

function baseAdapter(overrides = {}) {
  return {
    slug: "phase20-test-exam",
    name: "Phase20 Test Exam",
    fullForm: "Phase Twenty Test Examination",
    conductingBody: "Phase Twenty Test Board",
    officialWebsite: "http://127.0.0.1/",
    startUrls: ["http://127.0.0.1/"],
    render: "static",
    ...overrides,
  };
}

describe("Phase 20 — per-adapter crawl politeness", () => {
  it("1. schema accepts valid crawl configuration", () => {
    const parsed = SourceAdapterConfigSchema.parse(
      baseAdapter({
        crawl: { requestDelayMs: 500, timeoutMs: 10000, maxRetries: 3 },
      })
    );
    assert.deepEqual(parsed.crawl, {
      requestDelayMs: 500,
      timeoutMs: 10000,
      maxRetries: 3,
    });
    assert.deepEqual(SourceAdapterConfigSchema.parse(baseAdapter({ crawl: {} })).crawl, {
      requestDelayMs: null,
      timeoutMs: null,
      maxRetries: null,
    });
  });

  it("2. invalid/unsafe values are rejected", () => {
    const bad = [
      { requestDelayMs: -1 },
      { requestDelayMs: 60001 },
      { requestDelayMs: 1.5 },
      { timeoutMs: 999 },
      { timeoutMs: 120001 },
      { timeoutMs: "10s" },
      { maxRetries: -1 },
      { maxRetries: 6 },
      { maxRetries: 1.5 },
      { requestDelayMs: 100, politeness: true },
      "fast",
    ];
    for (const crawl of bad) {
      assert.equal(
        SourceAdapterConfigSchema.safeParse(baseAdapter({ crawl })).success,
        false,
        JSON.stringify(crawl)
      );
    }
  });

  it("3. defaults preserve current behavior (fetchers keep their own)", () => {
    for (const adapter of [{}, baseAdapter(), jeeAdapter, gateAdapter]) {
      const parsed = SourceAdapterConfigSchema.parse({
        ...baseAdapter(),
        ...adapter,
        crawl: adapter.crawl,
      });
      assert.deepEqual(parsed.crawl, {
        requestDelayMs: null,
        timeoutMs: null,
        maxRetries: null,
      });
      assert.deepEqual(crawlFetchOptions(parsed), {});
      assert.equal(crawlDelayMs(parsed), 0);
    }
    assert.deepEqual(crawlFetchOptions(undefined), {});
    assert.equal(crawlDelayMs(undefined), 0);
  });

  it("4. configured values map to fetch options", () => {
    assert.deepEqual(
      crawlFetchOptions({
        crawl: { requestDelayMs: 500, timeoutMs: 10000, maxRetries: 3 },
      }),
      { timeout: 10000, retries: 3 }
    );
    assert.deepEqual(crawlFetchOptions({ crawl: { timeoutMs: 5000 } }), {
      timeout: 5000,
    });
    assert.equal(
      crawlDelayMs({ crawl: { requestDelayMs: 250 } }),
      250
    );
  });

  it("5. retry count is actually respected", async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("boom");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/doc`;
      const meta = (u) => ({ label: "x", url: u, sourceUrl: u, type: "HTML" });
      await assert.rejects(
        fetchDocument(meta(url), { render: "static", crawl: { maxRetries: 2 } }),
        /failed/
      );
      assert.equal(hits, 3);
      await assert.rejects(
        fetchDocument(meta(url), { render: "static", crawl: { maxRetries: 0 } }),
        /failed/
      );
      assert.equal(hits, 4);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("6. timeout is actually respected", async () => {
    const sockets = new Set();
    const server = http.createServer(() => {
      // Hangs forever: only the client timeout can end this request.
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/hang`;
      const meta = { label: "x", url, sourceUrl: url, type: "HTML" };
      const started = Date.now();
      await assert.rejects(
        fetchDocument(meta, { render: "static", crawl: { timeoutMs: 300 } }),
        /failed/
      );
      assert.ok(Date.now() - started < 5000, "must not wait out the 15s default");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("7. delay is applied between consecutive requests", async () => {
    let savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    const { mongod, mongoUri } = await startIsolatedDb("phase20_delay");
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push(Date.now());
      res.writeHead(200, { "Content-Type": "text/html" });
      if (req.url === "/") {
        res.end(
          "<html><head><title>t</title></head><body>" +
            '<a href="/a.html">Doc alpha</a>' +
            '<a href="/b.html">Doc beta</a></body></html>'
        );
      } else {
        res.end("<html><head><title>doc</title></head><body><p>body text here</p></body></html>");
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const summary = await runIngestionPipeline(
        baseAdapter({
          officialWebsite: `${base}/`,
          startUrls: [`${base}/`],
          docRules: [
            { label: "alpha", match: ["alpha"], type: "HTML" },
            { label: "beta", match: ["beta"], type: "HTML" },
          ],
          crawl: { requestDelayMs: 300 },
        }),
        { mongoUri }
      );
      assert.equal(summary.stored, 2);
      assert.equal(hits.length, 3);
      for (let i = 1; i < hits.length; i++) {
        assert.ok(
          hits[i] - hits[i - 1] >= 200,
          `gap ${i} too small: ${hits[i] - hits[i - 1]}ms`
        );
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await closeIsolatedDb({ mongod, connection: null });
      if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    }
  });

  it("8+9. JEE behavior equivalent, GATE on safe defaults (adapters untouched)", () => {
    assert.ok(!("crawl" in jeeAdapter));
    assert.ok(!("crawl" in gateAdapter));
    for (const adapter of [jeeAdapter, gateAdapter]) {
      const parsed = SourceAdapterConfigSchema.parse(adapter);
      assert.deepEqual(parsed.crawl, {
        requestDelayMs: null,
        timeoutMs: null,
        maxRetries: null,
      });
      assert.deepEqual(crawlFetchOptions(parsed), {});
      assert.equal(crawlDelayMs(parsed), 0);
    }
  });

  it("10. no exam-specific crawl behavior in generic fetchers", () => {
    for (const relative of [
      "fetchers/httpFetcher.js",
      "fetchers/browserFetcher.js",
      "fetchers/documentFetcher.js",
      "pipeline/ingestionPipeline.js",
    ]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      const executable = code.replace(/\/\/.*$/gm, "");
      assert.ok(
        !/jee-main|gate-2026|\bnta\b|\biitg?\b/i.test(executable),
        `${relative} must not name exams`
      );
    }
    const fetcher = fs.readFileSync(
      path.join(__dirname, "..", "fetchers", "documentFetcher.js"),
      "utf8"
    );
    assert.ok(/adapter\.crawl/.test(fetcher), "options must come from adapter.crawl");
  });

  it("leaves no temporary/download artifacts in the repo", () => {
    const repoRoot = path.join(__dirname, "..");
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          entry.name.endsWith(".tmp") ||
          /^(download|temp).*\.pdf$/i.test(entry.name)
        ) {
          offenders.push(full);
        }
      }
    };
    walk(repoRoot);
    assert.deepEqual(offenders, []);
  });
});
