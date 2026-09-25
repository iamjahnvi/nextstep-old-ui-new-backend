// =============================================================================
// scraper/tests/batchIngestion.test.js
// =============================================================================
// WHAT: STEP 11 tests — bounded multi-candidate dry-run orchestration over
//   the Step 9 runner: explicit selection, per-candidate isolation, terminal
//   states, caps, determinism, and the no-publishing boundary.
// WHY: Batches must be boring: sequential, capped, fully reported, with one
//   candidate's failure never sinking the rest and publishing unreachable.
// DB: isolated mongodb-memory-server only; MONGO_URI unset. All I/O is
//   injected stubs over fixture HTML — never live sites, never publishing.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");

const gateAdapter = require("../registry/exams/gate-2026");
const { candidateIdFor } = require("../discovery/examDiscovery");
const { getExamCandidateModel } = require("../models/examCandidate");
const { getSourceProfileModel } = require("../models/sourceProfile");
const { getRawDocumentModel } = require("../models/rawDocument");
const { getExamEditionDraftModel } = require("../models/examEditionDraft");
const { getReviewStateModel } = require("../models/reviewState");
const { runBatchIngestion, DEFAULT_MAX_CANDIDATES } = require("../pipeline/batchIngestion");
const { parseArgs } = require("../cli/ingestBatch");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

const NOW = new Date("2026-09-24T00:00:00Z");
const HOST = "https://gate2026.iitg.ac.in";
const BODY = "Indian Institute of Technology Guwahati";

const ELIGIBILITY_HTML =
  "<html><head><title>Eligibility</title></head><body>" +
  "<h1>Eligibility Criteria</h1>" +
  "<p>Candidates must have completed a Bachelor's degree in Engineering or Technology from a recognized university.</p>" +
  "</body></html>";

const DATES_HTML =
  "<html><head><title>Dates</title></head><body>" +
  "<h1>Important Dates</h1>" +
  "<table><tr><td>Opening of online application</td><td>August 28, 2026</td></tr>" +
  "<tr><td>Closing Date of online application</td><td>October 07, 2026</td></tr></table>" +
  "</body></html>";

function landingFor(base) {
  return (
    "<html><head><title>Batch</title></head><body>" +
    `<a href="${base}/eligibility-criteria.html">Eligibility Criteria</a>` +
    `<a href="${base}/important-dates.html">Important Dates</a>` +
    "</body></html>"
  );
}

const VOLATILE_KEYS = new Set([
  "_id", "id", "draftId", "documentId", "decidedAt", "retrievedAt", "fetchedAt",
  "createdAt", "updatedAt", "currentFetchedAt", "previousFetchedAt", "durationMs",
]);

function projection(summary) {
  const clean = JSON.parse(JSON.stringify(summary, (key, value) => (VOLATILE_KEYS.has(key) ? undefined : value)));
  // Draft ObjectIds are volatile storage handles, not decisions: compare arity.
  if (clean && Array.isArray(clean.drafts)) clean.drafts = clean.drafts.length;
  return clean;
}

function candidateDoc(name, sourceBase, overrides = {}) {
  return {
    candidateId: candidateIdFor(name, 2027),
    name,
    description: null,
    conductingBody: BODY,
    examUrl: null,
    edition: "2027",
    year: 2027,
    sourceUrl: `${sourceBase}/`,
    sourceDomain: "gate2026.iitg.ac.in",
    discoverySource: "step11-test-seed",
    discoverySources: ["step11-test-seed"],
    discoveredAt: NOW,
    lastSeenAt: NOW,
    status: "DISCOVERED",
    evidence: [],
    ...overrides,
  };
}

describe("STEP 11 — batch dry-run ingestion", () => {
  let mongod;
  let mongoUri;
  let connection;
  let models;
  let savedMongoUri;

  const pagesFor = (base) => ({
    [`${base}/`]: landingFor(base),
    [`${base}/eligibility-criteria.html`]: ELIGIBILITY_HTML,
    [`${base}/important-dates.html`]: DATES_HTML,
  });

  function baseOptions({ extraPages = {}, failingUrls = [], maxCandidates } = {}) {
    const pages = { ...pagesFor(`${HOST}/alpha`), ...pagesFor(`${HOST}/delta`), ...extraPages };
    return {
      fetchPage: async (url) => {
        if (!pages[url]) throw new Error(`unexpected page fetch ${url}`);
        return { url, text: pages[url] };
      },
      fetchDocument: async (meta) => {
        if (failingUrls.includes(meta.url)) throw new Error(`fetch failed for ${meta.url}`);
        const html = pages[meta.url];
        if (!html) throw new Error(`unexpected document fetch ${meta.url}`);
        return {
          label: meta.label, url: meta.url, sourceUrl: meta.sourceUrl, type: "HTML",
          fetchedAt: NOW, status: 200, contentType: "text/html", content: html,
        };
      },
      year: 2027,
      cycle: "2027",
      dryRun: true,
      now: () => new Date(NOW),
      ...(maxCandidates === undefined ? {} : { maxCandidates }),
    };
  }

  async function reset(names) {
    for (const model of [models.ExamCandidate, models.SourceProfile, models.RawDocument, models.EditionDraft, models.ReviewState]) {
      await model.deleteMany({});
    }
    const created = {};
    for (const [name, base, overrides] of names) {
      const doc = candidateDoc(name, base, overrides || {});
      await models.ExamCandidate.create(doc);
      created[name] = doc.candidateId;
    }
    return created;
  }

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("step11_batch"));
    connection = await mongoose.createConnection(mongoUri).asPromise();
    models = {
      ExamCandidate: getExamCandidateModel(connection),
      SourceProfile: getSourceProfileModel(connection),
      RawDocument: getRawDocumentModel(connection),
      EditionDraft: getExamEditionDraftModel(connection),
      ReviewState: getReviewStateModel(connection),
      adapter: gateAdapter,
    };
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0, "batch must not leak connections");
  });

  it("1. mixed batch isolates every terminal state", async () => {
    const ids = await reset([
      ["Batch Alpha 2027", `${HOST}/alpha`],
      ["Batch Beta 2027", "https://unknown-portal.example.com", { conductingBody: null, sourceDomain: "unknown-portal.example.com" }],
      ["Batch Gamma 2027", `${HOST}/gamma`],
      ["Batch Delta 2027", `${HOST}/delta`],
      ["Batch Epsilon 2027", `${HOST}/epsilon`],
    ]);
    const gammaPages = {
      [`${HOST}/gamma/`]: `<html><body><a href="${HOST}/gamma/notice.html">Revised Schedule Notification</a></body></html>`,
    };
    const summary = await runBatchIngestion(
      { candidateIds: [ids["Batch Alpha 2027"], ids["Batch Beta 2027"], ids["Batch Gamma 2027"], ids["Batch Delta 2027"]] },
      models,
      baseOptions({ extraPages: gammaPages, failingUrls: [`${HOST}/gamma/notice.html`] })
    );
    assert.equal(summary.dryRun, true);
    assert.equal(summary.total, 4);
    assert.equal(summary.completed, 2);
    assert.equal(summary.reviewRequired, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.drafts.length, 2);
    const byId = Object.fromEntries(summary.results.map((r) => [r.candidateId, r]));
    assert.equal(byId[ids["Batch Alpha 2027"]].status, "DRAFT");
    assert.ok(byId[ids["Batch Alpha 2027"]].draftId);
    assert.equal(byId[ids["Batch Beta 2027"]].status, "REVIEW_REQUIRED");
    assert.equal(byId[ids["Batch Gamma 2027"]].status, "FETCH_FAILED");
    assert.ok(byId[ids["Batch Gamma 2027"]].error);
    // Gamma failed mid-batch; Delta still completed after it (isolation).
    assert.equal(byId[ids["Batch Delta 2027"]].status, "DRAFT");
    for (const result of summary.results) {
      assert.equal(typeof result.durationMs, "number");
      assert.ok(result.stoppedAt);
    }
    // Untouched sibling stays DISCOVERED.
    assert.equal((await models.ExamCandidate.findOne({ candidateId: ids["Batch Epsilon 2027"] })).status, "DISCOVERED");
    assert.equal(await models.EditionDraft.countDocuments({}), 2);
  });

  it("2. status selection, limits, duplicates, and empty selection", async () => {
    await reset([
      ["Batch Alpha 2027", `${HOST}/alpha`],
      ["Batch Delta 2027", `${HOST}/delta`],
    ]);
    const one = await runBatchIngestion({ status: "DISCOVERED", limit: 1 }, models, baseOptions());
    assert.equal(one.total, 1);
    const ids = await reset([
      ["Batch Alpha 2027", `${HOST}/alpha`],
    ]);
    const dupe = await runBatchIngestion({ candidateIds: [ids["Batch Alpha 2027"], ids["Batch Alpha 2027"]] }, models, baseOptions());
    assert.equal(dupe.total, 1);
    await assert.rejects(runBatchIngestion({ candidateIds: [] }, models, baseOptions()), /empty candidate selection/);
  });

  it("3. maxCandidates is enforced", async () => {
    assert.equal(DEFAULT_MAX_CANDIDATES, 5);
    const ids = await reset([
      ["Batch Alpha 2027", `${HOST}/alpha`],
      ["Batch Delta 2027", `${HOST}/delta`],
    ]);
    await assert.rejects(
      runBatchIngestion({ candidateIds: [ids["Batch Alpha 2027"], ids["Batch Delta 2027"]] }, models, baseOptions({ maxCandidates: 1 })),
      /maxCandidates/
    );
    const capped = await runBatchIngestion({ status: "DISCOVERED", limit: 10 }, models, baseOptions({ maxCandidates: 1 }));
    assert.equal(capped.total, 1);
  });

  it("4. unknown IDs record failure; non-DISCOVERED are skipped", async () => {
    const ids = await reset([["Batch Alpha 2027", `${HOST}/alpha`]]);
    const summary = await runBatchIngestion({ candidateIds: ["dsc-missing", ids["Batch Alpha 2027"]] }, models, baseOptions());
    assert.equal(summary.results[0].status, "DISCOVERY_FAILED");
    assert.equal(summary.results[1].status, "DRAFT");
    // Second run: Alpha is now SOURCE_VERIFIED, so it is skipped, not reprocessed.
    const again = await runBatchIngestion({ candidateIds: ["dsc-missing", ids["Batch Alpha 2027"]] }, models, baseOptions());
    assert.equal(again.results[1].status, "skipped");
    assert.equal(again.skipped, 1);
    assert.equal(await models.EditionDraft.countDocuments({}), 1);
  });

  it("5. production models are refused; publishing is unreachable", async () => {
    const ids = await reset([["Batch Alpha 2027", `${HOST}/alpha`]]);
    await assert.rejects(
      runBatchIngestion({ candidateIds: [ids["Batch Alpha 2027"]] }, { ...models, ExamModel: {} }, baseOptions()),
      /production models are refused/
    );
    for (const relative of ["pipeline/batchIngestion.js", "cli/ingestBatch.js"]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      assert.ok(!/require\(["'].*publish[^"']*["']\)/.test(code), `${relative}: no publish imports`);
      assert.ok(!/publishVerifiedDraft|confirmPublish|dryRunPublish/.test(code.replace(/\/\/.*$/gm, "")), `${relative}: no publish calls`);
      const executable = code
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
        .replace(/\/\/.*$/gm, "");
      assert.ok(!/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable), `${relative}: no exam names`);
    }
  });

  it("6. Step 9 is reused, not duplicated", () => {
    const code = fs.readFileSync(path.join(__dirname, "..", "pipeline", "batchIngestion.js"), "utf8");
    assert.ok(/require\(["']\.\/endToEndIngestion["']\)/.test(code), "delegates to runEndToEndIngestion");
    assert.ok(!/require\(["']\.\.\/(discovery|fetchers|extractors|validators|review|publish)[^"']*["']\)/.test(code), "no stage logic duplicated");
  });

  it("7. batch summaries are deterministic", async () => {
    const firstIds = await reset([
      ["Batch Alpha 2027", `${HOST}/alpha`],
      ["Batch Delta 2027", `${HOST}/delta`],
    ]);
    const first = projection(await runBatchIngestion({ candidateIds: [firstIds["Batch Alpha 2027"], firstIds["Batch Delta 2027"]] }, models, baseOptions()));
    const secondIds = await reset([
      ["Batch Alpha 2027", `${HOST}/alpha`],
      ["Batch Delta 2027", `${HOST}/delta`],
    ]);
    const second = projection(await runBatchIngestion({ candidateIds: [secondIds["Batch Alpha 2027"], secondIds["Batch Delta 2027"]] }, models, baseOptions()));
    assert.deepEqual(first, second);
  });

  it("8. CLI parses batch selection and refuses publishing", () => {
    const ids = parseArgs(["--candidate", "dsc-a", "--candidate", "dsc-b", "--adapter", "gate-2026", "--dry-run"]);
    assert.deepEqual(ids.candidateIds, ["dsc-a", "dsc-b"]);
    assert.equal(ids.adapter, "gate-2026");
    assert.equal(ids.dryRun, true);
    const byStatus = parseArgs(["--status", "DISCOVERED", "--limit", "3", "--adapter", "gate-2026", "--dry-run"]);
    assert.equal(byStatus.status, "DISCOVERED");
    assert.equal(byStatus.limit, 3);
    assert.throws(() => parseArgs(["--adapter", "gate-2026", "--dry-run"]), /empty candidate selection/);
    assert.throws(() => parseArgs(["--candidate", "dsc-a", "--adapter", "gate-2026", "--confirm"]), /never publish/);
    assert.throws(
      () => parseArgs(["--candidate", "dsc-a", "--status", "DISCOVERED", "--adapter", "gate-2026", "--dry-run"]),
      /cannot be combined/
    );
    assert.throws(() => parseArgs(["--status", "VERIFIED", "--adapter", "gate-2026", "--dry-run"]), /empty candidate selection|only DISCOVERED/);
  });
});
