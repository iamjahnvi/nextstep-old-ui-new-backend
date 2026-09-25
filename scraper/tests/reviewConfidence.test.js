// =============================================================================
// scraper/tests/reviewConfidence.test.js
// =============================================================================
// WHAT: STEP 8 tests — deterministic confidence (HIGH/MEDIUM/LOW/UNKNOWN),
//   review routing (AUTO_ACCEPTABLE/REVIEW_REQUIRED/CONFLICT/
//   INSUFFICIENT_EVIDENCE), evidence-preserving review items, draft readiness
//   stages, and drift re-review. LLM proposals appear only as review-only
//   attachments; nothing here publishes, fetches, or invokes any model.
// WHY: Operators need a triaged queue with everything attached — strong
//   fields pass silently, everything else surfaces with its reasons.
// DB: isolated mongodb-memory-server only for review-state persistence;
//   everything else is pure. MONGO_URI unset during the suite.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");

const { CONFIDENCE_LEVELS, evaluateFieldConfidence } = require("../validators/confidence");
const {
  REVIEW_STATUSES,
  DRAFT_REVIEW_STAGES,
  decideFieldReview,
  buildReviewItem,
  decideDraftReview,
  recordReviewState,
  getReviewState,
} = require("../review/reviewDecision");
const { DRIFT_TRIGGER_TYPES, compareForDrift } = require("../review/driftReview");
const { DRAFT_STATUSES } = require("../models/examEditionDraft");
const { REVIEW_STATE_COLLECTION, getReviewStateModel } = require("../models/reviewState");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

function strongEvidence(overrides = {}) {
  return {
    sourceUrl: "http://127.0.0.1/",
    documentUrl: "http://127.0.0.1/bulletin.html",
    docType: "HTML",
    retrievedAt: new Date("2026-01-02T00:00:00Z"),
    section: "information-bulletin",
    page: 3,
    excerpt: "Candidates must have passed Class 12.",
    confidence: "HIGH",
    extractor: "eligibility.v1",
    ...overrides,
  };
}

describe("STEP 8 — confidence evaluator", () => {
  it("1. strong corroborated evidence grades HIGH", () => {
    const out = evaluateFieldConfidence({
      status: "KNOWN",
      evidence: strongEvidence(),
      sourcesCount: 2,
    });
    assert.equal(out.confidence, "HIGH");
    assert.ok(out.reasons.length > 0);
    assert.deepEqual(CONFIDENCE_LEVELS, ["HIGH", "MEDIUM", "LOW", "UNKNOWN"]);
  });

  it("2. ordinary extractor output grades MEDIUM", () => {
    const out = evaluateFieldConfidence({
      status: "KNOWN",
      evidence: strongEvidence({ confidence: "MEDIUM", page: null }),
      sourcesCount: 1,
    });
    assert.equal(out.confidence, "MEDIUM");
  });

  it("3. conflicts, LLM-only provenance, and NEEDS_VERIFICATION cap at LOW", () => {
    assert.equal(evaluateFieldConfidence({ status: "KNOWN", evidence: strongEvidence(), conflict: true }).confidence, "LOW");
    assert.equal(evaluateFieldConfidence({ status: "KNOWN", evidence: strongEvidence(), llmOnly: true }).confidence, "LOW");
    assert.equal(evaluateFieldConfidence({ status: "NEEDS_VERIFICATION", evidence: strongEvidence() }).confidence, "LOW");
    assert.equal(
      evaluateFieldConfidence({ status: "UNKNOWN", evidence: strongEvidence({ confidence: "LOW" }) }).confidence,
      "LOW"
    );
  });

  it("4. missing evidence grades UNKNOWN", () => {
    assert.equal(evaluateFieldConfidence({ status: "KNOWN", evidence: null }).confidence, "UNKNOWN");
    assert.equal(evaluateFieldConfidence({}).confidence, "UNKNOWN");
  });
});

describe("STEP 8 — review routing", () => {
  it("5. conflicts route to CONFLICT with evidence kept", () => {
    const out = decideFieldReview({
      field: "registrationEnd",
      value: "2026-01-10T00:00:00.000Z",
      status: "KNOWN",
      evidence: strongEvidence(),
      conflict: true,
    });
    assert.equal(out.reviewStatus, "CONFLICT");
    assert.equal(out.confidence, "LOW");
  });

  it("6. empty fields route to INSUFFICIENT_EVIDENCE", () => {
    const out = decideFieldReview({ field: "syllabus", value: null, status: "UNKNOWN", evidence: null });
    assert.equal(out.reviewStatus, "INSUFFICIENT_EVIDENCE");
    assert.equal(out.confidence, "UNKNOWN");
  });

  it("7. missing provenance routes to REVIEW_REQUIRED, never auto-accepts", () => {
    const out = decideFieldReview({ field: "education", value: "12", status: "KNOWN", evidence: null });
    assert.equal(out.reviewStatus, "REVIEW_REQUIRED");
    const bad = decideFieldReview({
      field: "education",
      value: "12",
      status: "KNOWN",
      evidence: strongEvidence({ sourceUrl: null }),
    });
    assert.equal(bad.reviewStatus, "REVIEW_REQUIRED");
  });

  it("8. LLM-only proposals route to REVIEW_REQUIRED", () => {
    const out = decideFieldReview({
      field: "education",
      value: "12",
      status: "UNKNOWN",
      evidence: strongEvidence({ confidence: "LOW" }),
      llmOnly: true,
      llmProposal: { field: "education", status: "PROPOSED" },
    });
    assert.equal(out.reviewStatus, "REVIEW_REQUIRED");
    assert.equal(out.confidence, "LOW");
  });

  it("9. deterministic strength plus an LLM proposal stays authoritative", () => {
    const out = decideFieldReview({
      field: "education",
      value: "12",
      status: "KNOWN",
      evidence: strongEvidence(),
      sourcesCount: 2,
      llmProposal: { field: "education", proposedValue: "Graduate", status: "PROPOSED" },
    });
    assert.equal(out.reviewStatus, "AUTO_ACCEPTABLE");
    assert.equal(out.confidence, "HIGH");
    assert.ok(out.reasons.some((reason) => reason.includes("review-only")));
  });

  it("10. medium confidence routes to REVIEW_REQUIRED", () => {
    const out = decideFieldReview({
      field: "education",
      value: "12",
      status: "KNOWN",
      evidence: strongEvidence({ confidence: "MEDIUM", page: null }),
    });
    assert.equal(out.reviewStatus, "REVIEW_REQUIRED");
    assert.equal(out.confidence, "MEDIUM");
  });

  it("11. review items preserve the full evidence trail", () => {
    const reconciliation = {
      field: "registrationEnd",
      status: "CONFLICT",
      selectedValue: null,
      reason: "distinct values without explicit revision",
      candidates: [
        { value: "2026-01-10T00:00:00.000Z", evidence: strongEvidence({ excerpt: "10 Jan", page: 1 }) },
        { value: "2026-01-15T00:00:00.000Z", evidence: strongEvidence({ excerpt: "15 Jan", page: 2 }) },
      ],
      evidence: [],
      llmProposals: [{ value: "2026-01-15T00:00:00.000Z", authoritative: false, proposal: null }],
    };
    const item = buildReviewItem({
      field: "registrationEnd",
      value: null,
      status: "KNOWN",
      evidence: strongEvidence({ excerpt: "10 Jan", page: 1 }),
      conflict: true,
      reconciliation,
      llmProposal: { field: "registrationEnd", status: "PROPOSED" },
    });
    assert.equal(item.field, "registrationEnd");
    assert.equal(item.reviewStatus, "CONFLICT");
    assert.ok(item.sourceDocuments.includes("http://127.0.0.1/bulletin.html"));
    assert.deepEqual(item.pageNumbers, [1, 2]);
    assert.ok(item.excerpts.includes("10 Jan") && item.excerpts.includes("15 Jan"));
    assert.equal(item.reconciliation.candidates.length, 2);
    assert.deepEqual(item.llmProposal, { field: "registrationEnd", status: "PROPOSED" });
    assert.ok(item.reason);
    assert.ok(item.confidence);
  });

  it("12. draft stages roll up deterministically", () => {
    assert.deepEqual(decideDraftReview([]).stage, "DRAFT");
    const ready = decideDraftReview([
      { field: "a", reviewStatus: "AUTO_ACCEPTABLE" },
      { field: "b", reviewStatus: "AUTO_ACCEPTABLE" },
    ]);
    assert.equal(ready.stage, "READY_FOR_REVIEW");
    assert.deepEqual(ready.summary, { total: 2, autoAcceptable: 2, reviewRequired: 0, conflict: 0, insufficient: 0 });
    const conflicted = decideDraftReview([
      { field: "a", reviewStatus: "AUTO_ACCEPTABLE" },
      { field: "b", reviewStatus: "CONFLICT" },
    ]);
    assert.equal(conflicted.stage, "REVIEW_REQUIRED");
    const thin = decideDraftReview([{ field: "a", reviewStatus: "INSUFFICIENT_EVIDENCE" }]);
    assert.equal(thin.stage, "REVIEW_REQUIRED");
    assert.deepEqual(decideDraftReview(ready.items).stage, "READY_FOR_REVIEW");
  });
});

describe("STEP 8 — drift re-review", () => {
  const base = {
    sourceUrl: "http://127.0.0.1/",
    documentUrl: "http://127.0.0.1/bulletin.html",
    contentHash: "aaa",
    revision: false,
    evidenceExcerpts: ["Class 12 required"],
    value: "12",
  };

  it("13. content hash change triggers REVIEW_REQUIRED", () => {
    const out = compareForDrift({ previous: base, current: { ...base, contentHash: "bbb" } });
    assert.equal(out.drifted, true);
    assert.equal(out.decision, "REVIEW_REQUIRED");
    assert.ok(out.triggers.some((t) => t.type === "content-changed"));
  });

  it("14. unchanged snapshots produce NO_ACTION", () => {
    const out = compareForDrift({ previous: base, current: { ...base } });
    assert.equal(out.drifted, false);
    assert.deepEqual(out.triggers, []);
    assert.equal(out.decision, "NO_ACTION");
  });

  it("15. new revisions and removed evidence trigger review", () => {
    const revised = compareForDrift({ previous: base, current: { ...base, revision: true } });
    assert.equal(revised.decision, "REVIEW_REQUIRED");
    assert.ok(revised.triggers.some((t) => t.type === "revision-changed"));
    const removed = compareForDrift({ previous: base, current: { ...base, evidenceExcerpts: ["other text"] } });
    assert.equal(removed.decision, "REVIEW_REQUIRED");
    assert.ok(removed.triggers.some((t) => t.type === "evidence-removed"));
    const moved = compareForDrift({ previous: base, current: { ...base, documentUrl: "http://127.0.0.1/v2.html" } });
    assert.ok(moved.triggers.some((t) => t.type === "source-changed"));
    const changed = compareForDrift({ previous: base, current: { ...base, value: "Graduate" } });
    assert.ok(changed.triggers.some((t) => t.type === "value-changed"));
  });

  it("16. history is preserved and inputs are never mutated", () => {
    const previous = { ...base, evidenceExcerpts: [...base.evidenceExcerpts] };
    const current = { ...base, contentHash: "bbb", value: "Graduate" };
    const before = JSON.stringify({ previous, current });
    const out = compareForDrift({ previous, current });
    assert.equal(JSON.stringify({ previous, current }), before);
    assert.deepEqual(out.previous, previous);
    assert.equal(out.previous.contentHash, "aaa");
    assert.equal(out.previous.value, "12");
    assert.equal(out.current.contentHash, "bbb");
  });

  it("17. repeated inputs decide identically", () => {
    const run = () => compareForDrift({ previous: base, current: { ...base, contentHash: "zzz" } });
    assert.deepEqual(run(), run());
    assert.deepEqual(DRIFT_TRIGGER_TYPES, ["source-changed", "content-changed", "revision-changed", "evidence-removed", "value-changed"]);
  });
});

describe("STEP 8 — draft lifecycle and boundaries", () => {
  let mongod;
  let mongoUri;
  let connection;
  let ReviewState;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("step8_review"));
    connection = await mongoose.createConnection(mongoUri).asPromise();
    ReviewState = getReviewStateModel(connection);
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0, "review must not leak connections");
  });

  it("18. review readiness persists beside the draft with history", async () => {
    assert.equal(await getReviewState(ReviewState, "draft-1"), null);
    const first = await recordReviewState(
      ReviewState,
      "draft-1",
      { stage: "REVIEW_REQUIRED", items: [{ field: "education", reviewStatus: "REVIEW_REQUIRED" }] },
      { examSlug: "step8-exam" }
    );
    assert.equal(first.stage, "REVIEW_REQUIRED");
    assert.equal(first.examSlug, "step8-exam");
    assert.deepEqual(first.history, []);
    const second = await recordReviewState(ReviewState, "draft-1", { stage: "READY_FOR_REVIEW", items: [] });
    assert.equal(second.stage, "READY_FOR_REVIEW");
    assert.equal(second.history.length, 1);
    assert.equal(second.history[0].stage, "REVIEW_REQUIRED");
    assert.equal((await getReviewState(ReviewState, "draft-1")).stage, "READY_FOR_REVIEW");
    await assert.rejects(recordReviewState(ReviewState, "draft-1", { stage: "PUBLISHED", items: [] }), /decided draft stage/);
  });

  it("19. review stages never touch verification or publishing", () => {
    assert.deepEqual(DRAFT_REVIEW_STAGES, ["DRAFT", "REVIEW_REQUIRED", "READY_FOR_REVIEW"]);
    assert.ok(!DRAFT_REVIEW_STAGES.includes("PUBLISHED"));
    assert.ok(!DRAFT_REVIEW_STAGES.includes("VERIFIED"));
    assert.deepEqual(DRAFT_STATUSES, ["DRAFT", "VERIFIED", "REJECTED"]);
    assert.equal(REVIEW_STATE_COLLECTION, "scraper_review_states");
    assert.notEqual(REVIEW_STATE_COLLECTION, "exams");
  });

  it("20. review layer invokes no LLM, fetches nothing, publishes nothing", () => {
    for (const relative of ["validators/confidence.js", "review/reviewDecision.js", "review/driftReview.js", "models/reviewState.js"]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      assert.ok(!/semanticProposer|OllamaProvider|llmProposer/i.test(code), `${relative}: never invokes the LLM layer`);
      // No fetching or crawling deps anywhere; mongoose only inside the model
      // itself (standard staging-model convention, as with every other model).
      assert.ok(!/require\(["'].*(axios|playwright|crawlee)["']\)/.test(code), `${relative}: no fetching or crawling`);
      if (!relative.startsWith("models/")) {
        assert.ok(!/require\(["']mongoose["']\)/.test(code), `${relative}: no direct DB driver`);
      }
      assert.ok(!/publish/i.test(code.replace(/\/\/.*$/gm, "")), `${relative}: no publishing`);
      const executable = code
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
        .replace(/\/\/.*$/gm, "");
      assert.ok(!/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable), `${relative}: no exam names`);
    }
  });
});
