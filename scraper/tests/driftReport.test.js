// =============================================================================
// scraper/tests/driftReport.test.js
// =============================================================================
// WHAT: Phase 22 tests — re-crawl drift reporting (NEW | UNCHANGED | CHANGED)
//   over the shared crawl sequence. Monitoring only: nothing extracted,
//   reviewed, or published.
// WHY: Locks that a re-crawl produces an accurate per-document drift summary
//   with aggregate counts, preserves history, respects crawl politeness, and
//   leaves every other collection and pipeline untouched.
// SOURCE: local HTTP server with mutable page bodies (synthetic content,
//   official-site structure). No live network.
// DB: isolated mongodb-memory-server only; production MONGO_URI is unset.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const mongoose = require("mongoose");
const path = require("path");

const { runDriftReport } = require("../pipeline/driftReport");
const { crawlSource } = require("../pipeline/crawlSource");
const { parseArgs, main: runCliMain } = require("../cli/publish");
const {
  startIsolatedDb,
  connectRawDocuments,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

const LANDING_HTML =
  "<html><head><title>Drift Source</title></head><body>" +
  '<a href="/alpha.html">Alpha bulletin</a>' +
  '<a href="/beta.html">Beta bulletin</a>' +
  "</body></html>";

function docHtml(bodyText) {
  return (
    "<html><head><title>Doc</title></head><body>" +
    `<h1>Bulletin</h1><p>${bodyText}</p>` +
    "</body></html>"
  );
}

function testAdapter(overrides = {}) {
  return {
    slug: "phase22-test-exam",
    name: "Phase22 Test Exam",
    fullForm: "Phase Twenty-Two Test Examination",
    conductingBody: "Phase Twenty-Two Test Board",
    officialWebsite: "http://127.0.0.1/",
    startUrls: ["http://127.0.0.1/"],
    render: "static",
    docRules: [
      { label: "alpha", match: ["alpha bulletin"], type: "HTML" },
      { label: "beta", match: ["beta bulletin"], type: "HTML" },
    ],
    ...overrides,
  };
}

describe("Phase 22 — re-crawl drift report (monitoring only)", () => {
  let mongod;
  let mongoUri;
  let server;
  let baseUrl;
  let savedMongoUri;
  const pages = {};
  const hitTimes = [];

  function adapter(overrides = {}) {
    return testAdapter({
      officialWebsite: `${baseUrl}/`,
      startUrls: [`${baseUrl}/`],
      ...overrides,
    });
  }

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("phase22_drift_report"));
    pages["/alpha.html"] = docHtml("Alpha content version one, stable text here.");
    pages["/beta.html"] = docHtml("Beta content version one, stable text here.");

    server = http.createServer((req, res) => {
      hitTimes.push(Date.now());
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(pages[req.url] || LANDING_HTML);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeIsolatedDb({ mongod, connection: null });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0, "pipelines must not leak connections");
  });

  function byLabel(report, label) {
    const item = report.items.find((entry) => entry.label === label);
    assert.ok(item, `missing report item for ${label}`);
    return item;
  }

  it("1+2. first re-crawl reports NEW with full per-document detail", async () => {
    const report = await runDriftReport(adapter(), { mongoUri });
    assert.equal(report.adapter, "phase22-test-exam");
    assert.equal(report.strategy, "static");
    assert.ok(report.pageUrl.startsWith("http://127.0.0.1"));
    assert.equal(report.pageStatus, 200);
    assert.equal(report.checked, 2);
    assert.equal(report.new, 2);
    assert.equal(report.unchanged, 0);
    assert.equal(report.changed, 0);

    for (const label of ["alpha", "beta"]) {
      const item = byLabel(report, label);
      assert.equal(item.status, "NEW");
      assert.ok(item.url.startsWith("http://127.0.0.1"));
      assert.equal(item.previousChecksum, null);
      assert.equal(item.previousFetchedAt, null);
      assert.match(item.currentChecksum, /^[0-9a-f]{64}$/);
      assert.ok(!Number.isNaN(Date.parse(item.currentFetchedAt)));
      assert.equal(item.created, true);
      assert.ok(item.documentId);
    }
  });

  it("3. identical re-crawl reports UNCHANGED without new history", async () => {
    const report = await runDriftReport(adapter(), { mongoUri });
    assert.equal(report.checked, 2);
    assert.equal(report.new, 0);
    assert.equal(report.unchanged, 2);
    assert.equal(report.changed, 0);

    for (const label of ["alpha", "beta"]) {
      const item = byLabel(report, label);
      assert.equal(item.status, "UNCHANGED");
      assert.equal(item.previousChecksum, item.currentChecksum);
      assert.equal(item.created, false);
      assert.ok(!Number.isNaN(Date.parse(item.previousFetchedAt)));
    }

    const { connection, RawDocument } = await connectRawDocuments(mongoUri);
    try {
      assert.equal(await RawDocument.countDocuments({}), 2);
    } finally {
      await connection.close();
    }
  });

  it("4+5+6. changed content reports CHANGED and preserves history", async () => {
    pages["/beta.html"] = docHtml("Beta content version two, revised text here.");
    const report = await runDriftReport(adapter(), { mongoUri });
    assert.equal(report.checked, 2);
    assert.equal(report.new, 0);
    assert.equal(report.unchanged, 1);
    assert.equal(report.changed, 1);

    const alpha = byLabel(report, "alpha");
    assert.equal(alpha.status, "UNCHANGED");

    const beta = byLabel(report, "beta");
    assert.equal(beta.status, "CHANGED");
    assert.notEqual(beta.previousChecksum, beta.currentChecksum);
    assert.match(beta.previousChecksum, /^[0-9a-f]{64}$/);
    assert.equal(beta.created, true);

    const { connection, RawDocument } = await connectRawDocuments(mongoUri);
    try {
      assert.equal(await RawDocument.countDocuments({}), 3);
      const versions = await RawDocument.find({ url: beta.url })
        .sort({ fetchedAt: 1 })
        .lean();
      assert.equal(versions.length, 2);
      assert.equal(versions[0].checksum, beta.previousChecksum);
      assert.ok(versions[0].content.includes("version one"));
      assert.equal(versions[1].checksum, beta.currentChecksum);
      assert.ok(versions[1].content.includes("version two"));
    } finally {
      await connection.close();
    }
  });

  it("7. adapter crawl politeness is respected between requests", async () => {
    hitTimes.length = 0;
    const report = await runDriftReport(adapter({ crawl: { requestDelayMs: 250 } }), {
      mongoUri,
    });
    assert.equal(report.checked, 2);
    assert.ok(hitTimes.length >= 3, "landing plus two documents");
    for (let i = 1; i < hitTimes.length; i++) {
      assert.ok(
        hitTimes[i] - hitTimes[i - 1] >= 150,
        `gap ${i} too small: ${hitTimes[i] - hitTimes[i - 1]}ms`
      );
    }
  });

  it("8. no extraction, review, publish, or Exam side effects occur", async () => {
    await runDriftReport(adapter(), { mongoUri });
    const { connection } = await connectRawDocuments(mongoUri);
    try {
      assert.deepEqual(connection.modelNames(), ["ScraperRawDocument"]);
      const collections = await connection.db.listCollections().toArray();
      const names = collections
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith("system."));
      assert.deepEqual(names, ["scraper_rawdocuments"]);
    } finally {
      await connection.close();
    }

    for (const relative of [
      "pipeline/crawlSource.js",
      "pipeline/driftReport.js",
    ]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      const executable = code.replace(/\/\/.*$/gm, "");
      assert.ok(
        !/require\(["'][^"']*server\//.test(code),
        `${relative} must not import server code`
      );
      // No downstream-stage imports: extraction, review, adjudication,
      // publishing, validators, or Exam models may never load here.
      assert.ok(
        !/require\(["'][^"']*(extract|review|publish|validat)/i.test(executable) &&
          !/ExamEdition|getExamEditionDraft|getPublishReceipt|adjudicateDraft|runExtraction|runIngestion|publishVerifiedDraft|dryRunPublish|cron|redis|kafka|apify|openai|anthropic/i.test(
            executable
          ),
        `${relative} must not touch downstream stages`
      );
    }
  });

  it("9. no exam-specific literals in generic report code", () => {
    for (const relative of [
      "pipeline/crawlSource.js",
      "pipeline/driftReport.js",
      "cli/publish.js",
    ]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      const executable = code.replace(/\/\/.*$/gm, "");
      assert.ok(
        !/jee-main|gate-2026|\bnta\b|\biitg?\b/i.test(executable),
        `${relative} must name no exam`
      );
    }
  });

  it("crawlSource fails fast without network on a bad adapter", async () => {
    await assert.rejects(crawlSource(null), /startUrls is required/);
    await assert.rejects(crawlSource({}), /startUrls is required/);
  });

  it("CLI parses --drift-report and rejects bad usage without network", async () => {
    assert.deepEqual(
      parseArgs(["--drift-report", "gate-2026", "--mongo-uri", "u"]).driftReport,
      "gate-2026"
    );
    const env = { MONGO_URI: "mongodb://127.0.0.1:1/unused" };
    await assert.rejects(
      runCliMain(["--drift-report", "no-such-exam-xyz"], env),
      /unknown adapter/
    );
    await assert.rejects(
      runCliMain(["--drift-report", "BAD SLUG!"], env),
      /unknown adapter/
    );
    await assert.rejects(
      runCliMain(["--drift-report", "gate-2026", "--draft", "abc"], env),
      /cannot be combined/
    );
    await assert.rejects(runCliMain(["--drift-report", "gate-2026"], {}), /MongoDB URI/);
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
