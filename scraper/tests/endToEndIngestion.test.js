// =============================================================================
// scraper/tests/endToEndIngestion.test.js
// =============================================================================
// WHAT: STEP 9 tests — one GATE-shaped exam through the full dry-run pipeline
//   (DISCOVERED → verified → profiled → documents → fetch → process → extract
//   → validate → confidence/review → staged DRAFT), plus gate stops
//   (unverifiable source, empty discovery, total fetch failure), failure
//   isolation (one bad PDF never sinks the run), determinism, one-exam-only,
//   and the no-publish boundary.
// WHY: Prove the generic Steps 2–8 modules compose end to end before any
//   batch or production thinking. The run stops at DRAFT_REVIEW — staged,
//   awaiting a human, never promoted or published.
// DB: isolated mongodb-memory-server only; MONGO_URI unset. All I/O is
//   injected stubs over fixture HTML — never live external sites, never a
//   real Python service (HTML takes the Node path; the junk PDF fails closed).
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
const { runEndToEndIngestion } = require("../pipeline/endToEndIngestion");
const { parseArgs } = require("../cli/ingest");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

const NOW = new Date("2026-09-24T00:00:00Z");
const HOST = "https://gate2026.iitg.ac.in";
const BODY = "Indian Institute of Technology Guwahati";

const LANDING_HTML =
  "<html><head><title>GATE 2027</title></head><body>" +
  `<a href="${HOST}/eligibility-criteria.html">Eligibility Criteria</a>` +
  `<a href="${HOST}/important-dates.html">Important Dates</a>` +
  `<a href="${HOST}/bulletin.pdf">Information Bulletin</a>` +
  "</body></html>";

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

const VOLATILE_KEYS = new Set([
  "_id", "id", "draftId", "documentId", "decidedAt", "retrievedAt", "fetchedAt",
  "createdAt", "updatedAt", "currentFetchedAt", "previousFetchedAt",
]);

// Minimal valid one-page PDF (computed xref) so the Node PDF path parses it.
// Junk bytes would fail inside the reused extraction pipeline — which is
// all-or-nothing by design — so failure isolation is proven at fetch level.
function validPdfBytes(text) {
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = {};
  const obj = (num, body) => {
    offsets[num] = parts.reduce((n, p) => n + p.length, 0);
    parts.push(Buffer.from(`${num} 0 obj\n`), body, Buffer.from("\nendobj\n"));
  };
  obj(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  obj(3, Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"));
  const stream = Buffer.from(`BT /F1 12 Tf 50 250 Td (${text}) Tj ET`);
  obj(4, Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from("\nendstream")]));
  obj(5, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
  const xrefPos = parts.reduce((n, p) => n + p.length, 0);
  parts.push(Buffer.from("xref\n0 6\n"), Buffer.from("0000000000 65535 f \n"));
  for (let i = 1; i < 6; i += 1) parts.push(Buffer.from(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`));
  parts.push(Buffer.from(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`));
  return Buffer.concat(parts);
}

function projection(result) {
  return JSON.parse(JSON.stringify(result, (key, value) => (VOLATILE_KEYS.has(key) ? undefined : value)));
}

function candidateDoc(overrides = {}) {
  const name = overrides.name || "GATE 2027";
  return {
    candidateId: candidateIdFor(name, overrides.year === undefined ? 2027 : overrides.year),
    name,
    description: null,
    conductingBody: BODY,
    examUrl: null,
    edition: "2027",
    year: 2027,
    sourceUrl: `${HOST}/`,
    sourceDomain: "gate2026.iitg.ac.in",
    discoverySource: "step9-test-seed",
    discoverySources: ["step9-test-seed"],
    discoveredAt: NOW,
    lastSeenAt: NOW,
    status: "DISCOVERED",
    evidence: [],
    ...overrides,
  };
}

function stubFetchPage(map) {
  return async (url) => {
    if (!map[url]) throw new Error(`unexpected page fetch ${url}`);
    return { url, text: map[url] };
  };
}

function stubFetchDocument(map) {
  return async (meta) => {
    if (!map[meta.url]) throw new Error(`fetch failed for ${meta.url}`);
    return {
      label: meta.label,
      url: meta.url,
      sourceUrl: meta.sourceUrl,
      type: map[meta.url].type,
      fetchedAt: NOW,
      status: 200,
      contentType: map[meta.url].contentType,
      content: map[meta.url].content,
    };
  };
}

describe("STEP 9 — end-to-end dry-run ingestion (one exam)", () => {
  let mongod;
  let mongoUri;
  let connection;
  let models;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("step9_e2e"));
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
    assert.equal(open.length, 0, "ingestion must not leak connections");
  });

  async function reset() {
    for (const model of [models.ExamCandidate, models.SourceProfile, models.RawDocument, models.EditionDraft, models.ReviewState]) {
      await model.deleteMany({});
    }
  }

  function baseOptions(overrides = {}) {
    return {
      fetchPage: stubFetchPage({
        [`${HOST}/`]: LANDING_HTML,
        [`${HOST}/eligibility-criteria.html`]: ELIGIBILITY_HTML,
        [`${HOST}/important-dates.html`]: DATES_HTML,
      }),
      fetchDocument: stubFetchDocument({
        [`${HOST}/eligibility-criteria.html`]: { type: "HTML", contentType: "text/html", content: ELIGIBILITY_HTML },
        [`${HOST}/important-dates.html`]: { type: "HTML", contentType: "text/html", content: DATES_HTML },
        [`${HOST}/bulletin.pdf`]: { type: "PDF", contentType: "application/pdf", content: validPdfBytes("Bulletin Body") },
      }),
      year: 2027,
      cycle: "2027",
      dryRun: true,
      now: () => new Date(NOW),
      ...overrides,
    };
  }

  it("1. one exam runs DISCOVERED to staged DRAFT with review state", async () => {
    await reset();
    const cand = candidateDoc();
    await models.ExamCandidate.create(cand);

    const result = await runEndToEndIngestion(cand.candidateId, models, baseOptions());

    assert.equal(result.dryRun, true);
    assert.equal(result.adapter, "gate-2026");
    assert.equal(result.stages.load.status, "ok");
    assert.equal(result.stages.verification.status, "ok");
    assert.equal(result.stages.verification.verificationStatus, "SOURCE_VERIFIED");
    assert.equal(result.stages.profile.status, "ok");
    assert.equal(result.stages.profile.type, "STATIC_HTML");
    assert.equal(result.stages.profile.transport, "HTTP");
    assert.ok(result.stages.discovery.documents.length >= 2);
    assert.ok(result.stages.discovery.documents.some((d) => d.label === "ELIGIBILITY" || d.label === "IMPORTANT_DATES" || d.label === "BULLETIN"));
    assert.ok(result.stages.fetch.fetched.length >= 2);
    assert.ok(result.stages.processing.results.some((r) => r.via === "node"));
    assert.equal(result.stages.extraction.status, "ok");
    assert.equal(result.stages.extraction.year, 2027);
    assert.ok(result.stages.extraction.normalizedEdition.registration.startDate);
    assert.equal(result.stages.validation.editionOk, true);
    assert.ok(result.stages.confidence.fields.length > 0);
    assert.ok(result.stages.review.stage === "REVIEW_REQUIRED" || result.stages.review.stage === "READY_FOR_REVIEW");
    assert.equal(result.draft.status, "DRAFT");
    assert.ok(result.draft.draftId);
    assert.ok(["REVIEW_REQUIRED", "READY_FOR_REVIEW"].includes(result.review.stage));
    assert.ok(result.review.items.length > 0);
    assert.equal(result.stoppedAt.stage, "DRAFT_REVIEW");
    assert.deepEqual(result.confirmation, { published: false, productionWrites: 0, candidatesProcessed: 1 });
    assert.deepEqual(result.gates, {
      SOURCE_VERIFICATION: "passed",
      DOCUMENT_REVIEW: "passed",
      EXTRACTION_REVIEW: "passed",
      DRAFT_REVIEW: "reached",
    });

    // Staging persisted: candidate advanced, profile stored, raws staged,
    // exactly one DRAFT, review state recorded — and the draft was never
    // promoted or published.
    assert.equal((await models.ExamCandidate.findOne({ candidateId: cand.candidateId })).status, "SOURCE_VERIFIED");
    assert.ok(await models.SourceProfile.findOne({ candidateId: cand.candidateId }));
    assert.ok((await models.RawDocument.countDocuments({})) >= 2);
    assert.equal(await models.EditionDraft.countDocuments({}), 1);
    assert.equal((await models.ReviewState.findOne({ draftId: result.draft.draftId })).stage, result.review.stage);
  });

  it("2. one failed fetch is isolated; the rest still stage", async () => {
    await reset();
    const cand = candidateDoc();
    await models.ExamCandidate.create(cand);
    const failingFetch = async (meta) => {
      if (meta.url === `${HOST}/bulletin.pdf`) throw new Error(`fetch failed for ${meta.url}`);
      const map = {
        [`${HOST}/eligibility-criteria.html`]: ELIGIBILITY_HTML,
        [`${HOST}/important-dates.html`]: DATES_HTML,
      };
      return {
        label: meta.label, url: meta.url, sourceUrl: meta.sourceUrl, type: "HTML",
        fetchedAt: NOW, status: 200, contentType: "text/html", content: map[meta.url],
      };
    };
    const result = await runEndToEndIngestion(cand.candidateId, models, baseOptions({ fetchDocument: failingFetch }));
    assert.equal(result.stages.fetch.failed.length, 1);
    assert.equal(result.stages.fetch.failed[0].url, `${HOST}/bulletin.pdf`);
    assert.equal(result.stages.extraction.status, "ok");
    assert.equal(result.stoppedAt.stage, "DRAFT_REVIEW");
  });

  it("3. unverifiable source stops at the verification gate", async () => {
    await reset();
    const cand = candidateDoc({
      name: "Unknown Exam 2027",
      conductingBody: null,
      sourceUrl: "https://unknown-portal.example.com/",
      sourceDomain: "unknown-portal.example.com",
    });
    await models.ExamCandidate.create(cand);
    const result = await runEndToEndIngestion(cand.candidateId, models, baseOptions({
      fetchPage: stubFetchPage({ "https://unknown-portal.example.com/": LANDING_HTML }),
    }));
    assert.equal(result.stages.verification.status, "stopped");
    assert.equal(result.gates.SOURCE_VERIFICATION, "stopped");
    assert.equal(result.stoppedAt.stage, "REVIEW_REQUIRED");
    assert.ok(!result.draft);
    assert.equal(await models.EditionDraft.countDocuments({}), 0);
  });

  it("4. empty discovery stops at the document gate", async () => {
    await reset();
    const cand = candidateDoc();
    await models.ExamCandidate.create(cand);
    const result = await runEndToEndIngestion(cand.candidateId, models, baseOptions({
      fetchPage: stubFetchPage({ [`${HOST}/`]: "<html><head><title>t</title></head><body><p>Nothing here.</p></body></html>" }),
    }));
    assert.equal(result.gates.DOCUMENT_REVIEW, "stopped");
    assert.equal(result.stoppedAt.stage, "REVIEW_REQUIRED");
    assert.ok(!result.draft);
  });

  it("5. total fetch failure names its stage without fabricating data", async () => {
    await reset();
    const cand = candidateDoc();
    await models.ExamCandidate.create(cand);
    const result = await runEndToEndIngestion(cand.candidateId, models, baseOptions({
      fetchDocument: async (meta) => {
        throw new Error(`fetch failed for ${meta.url}`);
      },
    }));
    assert.equal(result.stoppedAt.stage, "FETCH_FAILED");
    assert.ok(result.stages.fetch.failed.length > 0);
    assert.ok(!result.draft);
    assert.equal(await models.EditionDraft.countDocuments({}), 0);
  });

  it("6. ambiguous extraction stops for human review, not a guess", async () => {
    await reset();
    const cand = candidateDoc();
    await models.ExamCandidate.create(cand);
    const ambiguousEligibility =
      "<html><body><p>Candidates with a Bachelor's degree may apply. Candidates with a Master's degree may also apply.</p></body></html>";
    const result = await runEndToEndIngestion(cand.candidateId, models, baseOptions({
      fetchDocument: stubFetchDocument({
        [`${HOST}/eligibility-criteria.html`]: { type: "HTML", contentType: "text/html", content: ambiguousEligibility },
        [`${HOST}/important-dates.html`]: { type: "HTML", contentType: "text/html", content: DATES_HTML },
      }),
    }));
    assert.equal(result.stoppedAt.stage, "DRAFT_REVIEW");
    const education = result.review.items.find((item) => item.field === "eligibility.education");
    assert.ok(education);
    assert.equal(education.reviewStatus, "REVIEW_REQUIRED");
    assert.equal(education.currentValue, null);
  });

  it("7. complete runs are deterministic", async () => {
    await reset();
    const cand = candidateDoc();
    await models.ExamCandidate.create(cand);
    const first = projection(await runEndToEndIngestion(cand.candidateId, models, baseOptions()));
    await models.ExamCandidate.deleteMany({});
    await models.SourceProfile.deleteMany({});
    await models.RawDocument.deleteMany({});
    await models.EditionDraft.deleteMany({});
    await models.ReviewState.deleteMany({});
    await models.ExamCandidate.create(candidateDoc());
    const second = projection(await runEndToEndIngestion(cand.candidateId, models, baseOptions()));
    assert.deepEqual(first, second);
  });

  it("8. exactly one exam runs; siblings are untouched", async () => {
    await reset();
    const first = candidateDoc();
    const second = candidateDoc({ name: "Other Exam 2027" });
    await models.ExamCandidate.create(first);
    await models.ExamCandidate.create(second);
    await runEndToEndIngestion(first.candidateId, models, baseOptions());
    assert.equal((await models.ExamCandidate.findOne({ candidateId: second.candidateId })).status, "DISCOVERED");
    assert.equal(await models.EditionDraft.countDocuments({}), 1);
  });

  it("9. dry-run refuses non-dry-run and non-candidates", async () => {
    await reset();
    const cand = candidateDoc();
    await models.ExamCandidate.create(cand);
    await assert.rejects(
      runEndToEndIngestion(cand.candidateId, models, baseOptions({ dryRun: false })),
      /only dry-run/
    );
    const missing = await runEndToEndIngestion("dsc-missing", models, baseOptions());
    assert.equal(missing.stoppedAt.stage, "DISCOVERY_FAILED");
    assert.match(missing.stoppedAt.reason, /candidate not found/);
    assert.ok(!missing.draft);
  });

  it("10. CLI parses single-candidate dry-run and refuses publishing", () => {
    const args = parseArgs(["--candidate", "dsc-abc", "--adapter", "gate-2026", "--dry-run"]);
    assert.equal(args.candidateId, "dsc-abc");
    assert.equal(args.adapter, "gate-2026");
    assert.equal(args.dryRun, true);
    assert.throws(() => parseArgs(["--candidate", "dsc-abc", "--adapter", "gate-2026", "--confirm"]), /never publishes/);
    assert.throws(() => parseArgs(["--adapter", "gate-2026", "--dry-run"]), /--candidate/);
  });

  it("11. orchestration and CLI publish nothing and know no exams", () => {
    for (const relative of ["pipeline/endToEndIngestion.js", "cli/ingest.js"]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      assert.ok(!/require\(["'].*publish[^"']*["']\)/.test(code), `${relative}: no publish imports`);
      assert.ok(!/publishVerifiedDraft|confirmPublish/.test(code.replace(/\/\/.*$/gm, "")), `${relative}: no publish calls`);
      const executable = code
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
        .replace(/\/\/.*$/gm, "");
      assert.ok(!/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable), `${relative}: no exam names`);
    }
  });
});
