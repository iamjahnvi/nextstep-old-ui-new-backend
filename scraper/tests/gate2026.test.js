// =============================================================================
// scraper/tests/gate2026.test.js
// =============================================================================
// WHAT: Phase 11 proof — the second exam (GATE 2026) runs entirely through
//   the generic pipeline driven by its registry config. No live network: a
//   local server reproduces the official site's STRUCTURE (landing links,
//   eligibility paragraphs, schedule <table>) with synthetic content.
// WHY: Proves the architecture is not JEE-specific: discovery, retrieval,
//   table-text parsing, date/eligibility extraction, staging, and draft
//   validation all work for a second source with zero exam-specific code.
// DB: isolated mongodb-memory-server only; MONGO_URI unset during the suite.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const mongoose = require("mongoose");
const path = require("path");

const gateAdapter = require("../registry/exams/gate-2026");
const { SourceAdapterConfigSchema } = require("../registry/schema");
const { runIngestionPipeline } = require("../pipeline/ingestionPipeline");
const { runExtractionPipeline } = require("../pipeline/extractionPipeline");
const { validateExamEdition } = require("../validators/examValidator");
const {
  startIsolatedDb,
  connectRawDocuments,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

const ELIGIBILITY_HTML =
  "<html><head><title>GATE 2026 Eligibility</title></head><body>" +
  "<h1>Eligibility Criteria</h1>" +
  "<p>Candidates must have completed a Bachelor's degree in Engineering or Technology from a recognized university.</p>" +
  "<p>More details of eligibility criteria are given below for all applicants.</p>" +
  "</body></html>";

const DATES_HTML =
  "<html><head><title>GATE 2026 Dates</title></head><body>" +
  "<h1>Important Dates</h1>" +
  "<table><tr><td>Opening of online application</td><td>August 28, 2025</td></tr>" +
  "<tr><td>Closing Date of online application</td><td>October 07, 2025</td></tr></table>" +
  "</body></html>";

describe("Phase 11 — GATE 2026 through the generic pipeline", () => {
  let mongod;
  let mongoUri;
  let server;
  let baseUrl;
  let savedMongoUri;

  function adapter() {
    return {
      ...gateAdapter,
      officialWebsite: `${baseUrl}/`,
      startUrls: [`${baseUrl}/`],
    };
  }

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("phase11_gate"));

    server = http.createServer((req, res) => {
      if (req.url === "/eligibility-criteria.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(ELIGIBILITY_HTML);
      } else if (req.url === "/important-dates.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(DATES_HTML);
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><head><title>GATE 2026</title></head><body>" +
            '<a href="/eligibility-criteria.html">Eligibility Criteria</a>' +
            '<a href="/important-dates.html">Important Dates</a>' +
            "</body></html>"
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
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0, "pipelines must not leak connections");
  });

  it("registry config is valid, static, and classification-free", () => {
    const parsed = SourceAdapterConfigSchema.safeParse(gateAdapter);
    assert.equal(parsed.success, true);
    assert.equal(gateAdapter.render, "static");
    assert.equal(gateAdapter.slug, "gate-2026");
    assert.ok(!("careerType" in gateAdapter));
    assert.ok(!("examType" in gateAdapter));
    assert.ok(!("month" in gateAdapter));
    assert.deepEqual(
      gateAdapter.docRules.map((r) => r.label).sort(),
      ["eligibility", "important-dates"]
    );
  });

  it("ingests both documents and extracts a valid DRAFT", async () => {
    const ingestion = await runIngestionPipeline(adapter(), { mongoUri });
    assert.equal(ingestion.adapter, "gate-2026");
    assert.equal(ingestion.strategy, "static");
    assert.equal(ingestion.discovered, 2);
    assert.equal(ingestion.stored, 2);
    assert.ok(
      ingestion.pageUrl.startsWith("http://127.0.0.1"),
      "no live dependency"
    );

    const { connection, RawDocument } = await connectRawDocuments(mongoUri);
    try {
      assert.equal(await RawDocument.countDocuments({}), 2);
    } finally {
      await connection.close();
    }

    const extraction = await runExtractionPipeline(adapter(), {
      mongoUri,
      year: 2026,
      cycle: "2026",
    });
    assert.equal(extraction.year, 2026);
    assert.equal(extraction.cycle, "2026");
    assert.ok(validateExamEdition(extraction.edition).success);

    // Dates come from the schedule <table> via the generic tables path.
    assert.equal(
      extraction.edition.registration.startDate.toISOString(),
      "2025-08-28T00:00:00.000Z"
    );
    assert.equal(
      extraction.edition.registration.endDate.toISOString(),
      "2025-10-07T00:00:00.000Z"
    );

    // Degree rules yield a KNOWN education level; the rest stay UNKNOWN.
    assert.equal(extraction.edition.eligibility.education.status, "KNOWN");
    assert.equal(
      extraction.edition.eligibility.education.minLevel,
      "Graduate"
    );
    assert.equal(extraction.edition.eligibility.percentage.status, "UNKNOWN");
    assert.equal(extraction.edition.eligibility.age.status, "UNKNOWN");

    // Evidence is attached and points at the staged sources.
    assert.ok(extraction.edition.sources.length > 0);
    for (const source of extraction.edition.sources) {
      assert.ok(source.documentUrl.startsWith("http://127.0.0.1"));
    }

    // Contract holds for the second exam too.
    assert.equal(extraction.exam.careerType, null);
    assert.equal(extraction.exam.examType, null);
    assert.ok(!("month" in extraction.edition));
    assert.equal(extraction.edition.status, "DRAFT");
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
