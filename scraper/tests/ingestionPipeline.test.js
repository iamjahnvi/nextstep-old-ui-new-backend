// =============================================================================
// scraper/tests/ingestionPipeline.test.js
// =============================================================================
// WHAT: Phase 4 pipeline test — fetch → parse → discover → retrieve →
//   validate → persist — against a LOCAL HTTP server. No live NTA website.
// WHY: Proves the pipeline orchestrates the existing Phase 1–3 modules and
//   persists HTML (text) + PDF (Buffer) into isolated staging storage.
// DB: isolated mongodb-memory-server URI passed via options.mongoUri.
// RUN: npm test (node --test tests/)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const mongoose = require("mongoose");
const path = require("path");

const { runIngestionPipeline } = require("../pipeline/ingestionPipeline");
const {
  startIsolatedDb,
  connectRawDocuments,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

const FIXTURE_PDF = path.join(__dirname, "fixtures", "sample.pdf");
const ABOUT_HTML =
  "<html><head><title>About</title></head><body><h1>About page</h1><p>Local about page body for pipeline verification.</p></body></html>";

describe("Phase 4 — ingestionPipeline (local server, isolated DB)", () => {
  let mongod;
  let mongoUri;
  let server;
  let baseUrl;
  let savedMongoUri;
  const pdfBytes = fs.readFileSync(FIXTURE_PDF);

  function adapterConfig() {
    return {
      slug: "phase4-test-exam",
      name: "Phase4 Test Exam",
      fullForm: "Phase Four Test Examination",
      conductingBody: "Phase Four Test Board",
      officialWebsite: `${baseUrl}/`,
      startUrls: [`${baseUrl}/`],
      render: "static",
      docRules: [
        { label: "information-bulletin", match: ["information bulletin"], type: "PDF" },
        { label: "about-page", match: ["about page"], type: "HTML" },
      ],
    };
  }

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("phase4_pipeline"));

    server = http.createServer((req, res) => {
      if (req.url === "/bulletin.pdf") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end(pdfBytes);
      } else if (req.url === "/about.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(ABOUT_HTML);
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><head><title>Test landing</title></head><body>` +
            `<a href="/bulletin.pdf">Information Bulletin 2026</a>` +
            `<a href="/about.html">About page</a>` +
            `</body></html>`
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeIsolatedDb({ mongod, connection: null });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    // Pipeline must close its own connections: none left open.
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0, "pipeline must not leak connections");
  });

  it("6. processes local HTML + PDF and returns expected summary/results", async () => {
    const adapter = adapterConfig();
    assert.ok(
      adapter.startUrls[0].includes("127.0.0.1"),
      "must NOT depend on the live NTA website"
    );

    const summary = await runIngestionPipeline(adapter, { mongoUri });

    assert.equal(summary.adapter, "phase4-test-exam");
    assert.equal(summary.strategy, "static");
    assert.equal(summary.discovered, 2);
    assert.equal(summary.stored, 2);
    assert.equal(summary.results.length, 2);

    const byLabel = Object.fromEntries(summary.results.map((r) => [r.label, r]));
    assert.ok(byLabel["information-bulletin"]);
    assert.ok(byLabel["about-page"]);
    assert.equal(byLabel["information-bulletin"].type, "PDF");
    assert.equal(byLabel["about-page"].type, "HTML");
    for (const r of summary.results) {
      assert.match(r.checksum, /^[0-9a-f]{64}$/);
      assert.equal(r.created, true);
      assert.ok(r.id);
    }

    // PDF checksum matches the served fixture bytes.
    assert.equal(
      byLabel["information-bulletin"].checksum,
      crypto.createHash("sha256").update(pdfBytes).digest("hex")
    );

    // Verify persisted documents via an isolated verification connection.
    const { connection, RawDocument } = await connectRawDocuments(mongoUri);
    try {
      assert.equal(await RawDocument.countDocuments({}), 2);
      const storedPdf = await RawDocument.findOne({
        url: `${baseUrl}/bulletin.pdf`,
      }).lean();
      assert.equal(storedPdf.type, "PDF");
      const storedPdfBytes = Buffer.isBuffer(storedPdf.content)
        ? storedPdf.content
        : Buffer.from(storedPdf.content.buffer);
      assert.ok(storedPdfBytes.equals(pdfBytes), "PDF bytes must round-trip");

      const storedHtml = await RawDocument.findOne({
        url: `${baseUrl}/about.html`,
      }).lean();
      assert.equal(storedHtml.type, "HTML");
      assert.equal(typeof storedHtml.content, "string");
      assert.ok(storedHtml.content.includes("About page"));
    } finally {
      await connection.close();
    }

    // Re-run: unchanged sources are deduped, nothing new stored.
    const second = await runIngestionPipeline(adapter, { mongoUri });
    assert.equal(second.discovered, 2);
    assert.equal(second.stored, 0);
    assert.ok(second.results.every((r) => r.created === false));

    const { connection: c2, RawDocument: M2 } = await connectRawDocuments(mongoUri);
    try {
      assert.equal(await M2.countDocuments({}), 2);
    } finally {
      await c2.close();
    }
  });

  it("7. cleanup — no temp/download artifacts; staging DB is isolated", async () => {
    assert.ok(mongoUri.includes("127.0.0.1"), "tests must use in-memory URI");
    assert.notEqual(mongoUri, savedMongoUri);

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
    assert.deepEqual(offenders, [], "scraper artifacts must not remain");
  });
});
