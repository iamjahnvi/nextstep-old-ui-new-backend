// =============================================================================
// scraper/review/reviewDecision.js — STEP 8 review decisions
// =============================================================================
// WHAT: Deterministic review routing for extracted fields and drafts. Turns
//   confidence + reconciliation + provenance signals into one of
//   AUTO_ACCEPTABLE | REVIEW_REQUIRED | CONFLICT | INSUFFICIENT_EVIDENCE per
//   field, rolls fields up into a draft stage (DRAFT | REVIEW_REQUIRED |
//   READY_FOR_REVIEW), and persists that readiness beside the draft — never
//   inside its promotion status and never toward publishing.
// WHY: Operators need a triaged queue: strong fields pass through, conflicts
//   and thin evidence surface with everything attached. AUTO_ACCEPTABLE means
//   "no review flag raised", never "publish this" — no publish path reads
//   these decisions (this module does not import publish code, crawlers, or
//   any LLM invoker).
// FIELD RULES (evaluated in order):
//   missing/invalid provenance (no evidence, or no sourceUrl) -> REVIEW_REQUIRED.
//   reconciliation conflict                                    -> CONFLICT.
//   no value and no informative evidence                      -> INSUFFICIENT_EVIDENCE.
//   UNKNOWN status with preserved evidence                    -> REVIEW_REQUIRED.
//   LLM-only (value or proposal, no deterministic evidence)    -> REVIEW_REQUIRED.
//   NEEDS_VERIFICATION                                        -> REVIEW_REQUIRED.
//   confidence HIGH                                           -> AUTO_ACCEPTABLE.
//   confidence MEDIUM/LOW                                     -> REVIEW_REQUIRED.
//   LLM proposals never change the status: they ride the review item as
//   review-only evidence, and a deterministic AUTO_ACCEPTABLE stays
//   AUTO_ACCEPTABLE with the proposal attached.
// DRAFT ROLLUP: any CONFLICT -> REVIEW_REQUIRED; else any REVIEW_REQUIRED ->
//   REVIEW_REQUIRED; else any INSUFFICIENT_EVIDENCE -> REVIEW_REQUIRED (an
//   unevidenced field still wants operator awareness); all AUTO_ACCEPTABLE ->
//   READY_FOR_REVIEW; no items evaluated -> DRAFT.
// CONTRACTS:
//   decideFieldReview(input) -> { reviewStatus, confidence, reasons[] }.
//     input: { field, value, status, evidence, sourcesCount?, revision?,
//              conflict?, llmOnly?, llmProposal?, provenanceValid? }.
//   buildReviewItem(input) -> full review item (field, currentValue,
//     confidence, reviewStatus, sourceDocuments, pageNumbers, sections,
//     excerpts, reconciliation, llmProposal, reason). Losing candidates and
//     conflicting evidence are never discarded.
//   decideDraftReview(items) -> { stage, summary } (pure).
//   recordReviewState(ReviewState, draftId, decision, { examSlug? })
//     -> persisted state (upserts by draftId, pushes the previous stage into
//        history — history is never overwritten).
//   getReviewState(ReviewState, draftId) -> stored state or null.
// GENERICITY: field-agnostic. No exam names, no field-specific rules.
// =============================================================================

const { evaluateFieldConfidence } = require("../validators/confidence");
const { REVIEW_STATE_COLLECTION } = require("../models/reviewState");

const REVIEW_STATUSES = ["AUTO_ACCEPTABLE", "REVIEW_REQUIRED", "CONFLICT", "INSUFFICIENT_EVIDENCE"];
const DRAFT_REVIEW_STAGES = ["DRAFT", "REVIEW_REQUIRED", "READY_FOR_REVIEW"];

function provenanceOf(evidence) {
  if (!evidence || typeof evidence !== "object") {
    return { valid: false, reason: "no evidence attached" };
  }
  if (typeof evidence.sourceUrl !== "string" || !evidence.sourceUrl) {
    return { valid: false, reason: "evidence has no sourceUrl" };
  }
  return { valid: true, reason: null };
}

function decideFieldReview(input = {}) {
  const field = typeof input.field === "string" && input.field ? input.field : "field";
  const reasons = [];
  const provenance = input.provenanceValid === false ? { valid: false, reason: "provenance marked invalid" } : provenanceOf(input.evidence);
  const hasValue = input.value !== null && input.value !== undefined;
  const hasEvidence = input.evidence !== null && input.evidence !== undefined;
  const llmOnly = input.llmOnly === true;
  const conflict = input.conflict === true;

  const confidence = evaluateFieldConfidence({
    status: input.status,
    evidence: input.evidence,
    sourcesCount: input.sourcesCount,
    revision: input.revision,
    conflict,
    llmOnly,
  }).confidence;

  if (conflict) {
    reasons.push("reconciliation reports conflicting deterministic values");
    return { field, reviewStatus: "CONFLICT", confidence, reasons };
  }
  if (!hasValue && !hasEvidence) {
    reasons.push("no value and no evidence to review");
    return { field, reviewStatus: "INSUFFICIENT_EVIDENCE", confidence, reasons };
  }
  if (!provenance.valid) {
    reasons.push(provenance.reason);
    return { field, reviewStatus: "REVIEW_REQUIRED", confidence, reasons };
  }
  if (!hasValue && input.status === "UNKNOWN") {
    reasons.push("ambiguous evidence preserved without a claimed value");
    return { field, reviewStatus: "REVIEW_REQUIRED", confidence, reasons };
  }
  if (llmOnly) {
    reasons.push("LLM-only provenance requires human review");
    return { field, reviewStatus: "REVIEW_REQUIRED", confidence, reasons };
  }
  if (input.status === "NEEDS_VERIFICATION") {
    reasons.push("status NEEDS_VERIFICATION requires human review");
    return { field, reviewStatus: "REVIEW_REQUIRED", confidence, reasons };
  }
  if (confidence === "HIGH") {
    reasons.push("strong deterministic evidence with no conflicts");
    if (input.llmProposal !== null && input.llmProposal !== undefined) {
      reasons.push("an LLM proposal is attached as review-only evidence; the deterministic value stays authoritative");
    }
    return { field, reviewStatus: "AUTO_ACCEPTABLE", confidence, reasons };
  }
  reasons.push(`confidence ${confidence} wants human eyes`);
  if (input.llmProposal !== null && input.llmProposal !== undefined) {
    reasons.push("an LLM proposal is attached as review-only evidence");
  }
  return { field, reviewStatus: "REVIEW_REQUIRED", confidence, reasons };
}

function stringsOf(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry !== null && entry !== undefined) out.push(entry);
  }
  return out;
}

function buildReviewItem(input = {}) {
  const decision = decideFieldReview(input);
  // Dedupe by content (document + excerpt): the field evidence and a
  // candidate's evidence often describe the same sighting as distinct objects.
  const seenEvidence = new Set();
  const evidenceList = [];
  const addEvidence = (entry) => {
    if (!entry || typeof entry !== "object") return;
    const key = `${entry.documentUrl || entry.sourceUrl || ""}|${entry.excerpt || ""}`;
    if (!seenEvidence.has(key)) {
      seenEvidence.add(key);
      evidenceList.push(entry);
    }
  };
  addEvidence(input.evidence);
  const reconciliation = input.reconciliation === undefined ? null : input.reconciliation;
  if (reconciliation && Array.isArray(reconciliation.candidates)) {
    for (const candidate of reconciliation.candidates) {
      addEvidence(candidate && candidate.evidence);
    }
  }
  return {
    field: decision.field,
    currentValue: input.value === undefined ? null : input.value,
    confidence: decision.confidence,
    reviewStatus: decision.reviewStatus,
    sourceDocuments: stringsOf(evidenceList.map((e) => e.documentUrl || e.sourceUrl)),
    pageNumbers: stringsOf(evidenceList.map((e) => (e.page === undefined ? null : e.page))).filter((p) => p !== null),
    sections: stringsOf(evidenceList.map((e) => e.section)).filter((s) => s !== null),
    excerpts: stringsOf(evidenceList.map((e) => e.excerpt)).filter((x) => x !== null),
    reconciliation,
    llmProposal: input.llmProposal === undefined ? null : input.llmProposal,
    reason: decision.reasons.join("; "),
  };
}

function decideDraftReview(items) {
  const list = Array.isArray(items) ? items : [];
  const summary = { total: list.length, autoAcceptable: 0, reviewRequired: 0, conflict: 0, insufficient: 0 };
  for (const item of list) {
    if (!item) continue;
    if (item.reviewStatus === "CONFLICT") summary.conflict += 1;
    else if (item.reviewStatus === "REVIEW_REQUIRED") summary.reviewRequired += 1;
    else if (item.reviewStatus === "INSUFFICIENT_EVIDENCE") summary.insufficient += 1;
    else if (item.reviewStatus === "AUTO_ACCEPTABLE") summary.autoAcceptable += 1;
  }
  let stage = "DRAFT";
  if (list.length > 0) {
    if (summary.conflict > 0) stage = "REVIEW_REQUIRED";
    else if (summary.reviewRequired > 0) stage = "REVIEW_REQUIRED";
    else if (summary.insufficient > 0) stage = "REVIEW_REQUIRED";
    else stage = "READY_FOR_REVIEW";
  }
  return { stage, summary, items: list };
}

function assertReviewStateModel(ReviewState) {
  if (!ReviewState || !ReviewState.collection) {
    throw new Error("reviewDecision: a review-state model is required");
  }
  if (ReviewState.collection.name !== REVIEW_STATE_COLLECTION) {
    throw new Error(
      `reviewDecision: refusing to operate on collection "${ReviewState.collection.name}" ` +
        `(review states live in "${REVIEW_STATE_COLLECTION}")`
    );
  }
}

async function recordReviewState(ReviewState, draftId, decision, options = {}) {
  assertReviewStateModel(ReviewState);
  if (typeof draftId !== "string" || !draftId) {
    throw new Error("reviewDecision: draftId is required");
  }
  if (!decision || typeof decision.stage !== "string" || !DRAFT_REVIEW_STAGES.includes(decision.stage)) {
    throw new Error("reviewDecision: a decided draft stage is required");
  }
  const decidedAt = new Date();
  const existing = await ReviewState.findOne({ draftId });
  if (!existing) {
    return ReviewState.create({
      draftId,
      examSlug: options.examSlug || null,
      stage: decision.stage,
      items: Array.isArray(decision.items) ? decision.items : [],
      decidedAt,
      history: [],
    });
  }
  existing.history.push({ stage: existing.stage, decidedAt: existing.decidedAt, itemCount: existing.items.length });
  existing.stage = decision.stage;
  existing.items = Array.isArray(decision.items) ? decision.items : [];
  existing.decidedAt = decidedAt;
  if (options.examSlug) existing.examSlug = options.examSlug;
  await existing.save();
  return existing;
}

async function getReviewState(ReviewState, draftId) {
  assertReviewStateModel(ReviewState);
  return ReviewState.findOne({ draftId });
}

module.exports = {
  REVIEW_STATUSES,
  DRAFT_REVIEW_STAGES,
  decideFieldReview,
  buildReviewItem,
  decideDraftReview,
  recordReviewState,
  getReviewState,
};
