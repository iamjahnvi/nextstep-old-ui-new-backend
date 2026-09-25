// =============================================================================
// scraper/pipeline/publishIntegration.js — STEP 10 single-draft publish proof
// =============================================================================
// WHAT: Thin orchestration connecting one Step 9 draft to the EXISTING publish
//   boundary (publishValidator → publishService → publishExecutor → examMapper).
//   No publishing logic lives here: this module loads one draft, dry-runs,
//   demands explicit confirmation for the single write, then verifies the
//   stored record field-by-field against the validated payload.
// WHY: Prove exactly one validated draft can cross the boundary safely —
//   dry-run first (zero writes, proven by before/after counts), explicit
//   confirm second, verification third. Anything else (batches, wildcards,
//   latest-pick, auto-confirm) is refused loudly.
// FLOW:
//   dryRunSingleDraft(...)    -> { dryRun, draftId, identity, validation,
//                                  exam payload, provenance, wouldPublish,
//                                  writes: 0 } (refuses arrays; proves no
//                                  writes via staging counts before/after).
//   publishSingleDraft(..., { confirm }) -> confirm must be exactly true or
//     it throws (missing confirmation refuses publishing). On success returns
//     { publishSucceeded, draftId, publishedId, action, wrote,
//       verificationPassed, mismatches }. On executor refusal returns
//     { publishSucceeded: false, stage: "PUBLISH_REJECTED", error } — a failed
//     publish never reports success, and nothing is repaired or guessed.
//   Verification compares the stored Exam record against the mapped payload:
//   identity, name, fullForm, description, eligibility (level/percentage/age),
//   registration dates (ISO), officialWebsite, streams, subjects, plus
//   provenance source/evidence counts. Mismatches are reported, never fixed.
// CONTRACTS take staging models + an ExamModel exactly like the executor
//   (tests pass an isolated stand-in on the throwaway "exams" collection).
// GENERICITY: no exam names, no field invention — comparison reuses the
//   executor's own mapped output as the expected value.
// =============================================================================

const { dryRunPublish, publishVerifiedDraft } = require("../publish/publishExecutor");

function assertSingleDraftId(draftId) {
  if (typeof draftId !== "string" || !draftId) {
    throw new Error(
      "publishIntegration: exactly one draftId string is required (no batches, no wildcards, no arrays)"
    );
  }
}

async function countOf(model) {
  if (!model || typeof model.countDocuments !== "function") return null;
  return model.countDocuments({});
}

async function dryRunSingleDraft({ EditionDraft, Receipt }, draftId) {
  assertSingleDraftId(draftId);
  const before = {
    drafts: await countOf(EditionDraft),
    receipts: await countOf(Receipt),
  };
  const dry = await dryRunPublish(EditionDraft, { Receipt, draftId });
  const after = {
    drafts: await countOf(EditionDraft),
    receipts: await countOf(Receipt),
  };
  const writes = (after.drafts ?? before.drafts ?? 0) - (before.drafts ?? 0) +
    ((after.receipts ?? before.receipts ?? 0) - (before.receipts ?? 0));
  return {
    dryRun: true,
    draftId: dry.draftId,
    identity: dry.identity,
    target: dry.target,
    validation: dry.validation,
    exam: dry.exam,
    provenance: dry.provenance,
    publishEligibility: dry.action,
    wouldPublish: dry.action === "would-create",
    writes,
    publishedRecordsCreated: 0,
  };
}

function normalizeForCompare(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = normalizeForCompare(value[key]);
    return sorted;
  }
  return value === undefined ? null : value;
}

function compareField(mismatches, label, expected, actual) {
  const left = JSON.stringify(normalizeForCompare(expected));
  const right = JSON.stringify(normalizeForCompare(actual));
  if (left !== right) {
    mismatches.push({ field: label, expected: normalizeForCompare(expected), actual: normalizeForCompare(actual) });
  }
}

function verifyPublishedRecord({ stored, mappedExam, draft, identity }) {
  const mismatches = [];
  const plain = stored && typeof stored.toObject === "function" ? stored.toObject() : stored;
  compareField(mismatches, "identity", identity, `${draft.edition.examSlug}:${draft.edition.year}:${draft.edition.cycle}`);
  for (const key of [
    "name",
    "fullForm",
    "description",
    "minimumEducationLevel",
    "minimumAge",
    "registrationStartDate",
    "registrationEndDate",
    "officialWebsite",
    "streams",
    "subjects",
  ]) {
    compareField(mismatches, key, mappedExam[key], plain[key]);
  }
  if (mappedExam.eligibility !== undefined || plain.eligibility !== undefined) {
    compareField(mismatches, "eligibility", mappedExam.eligibility || null, plain.eligibility || null);
  }
  // Provenance legs: edition.sources <-> provenance.evidence (extraction
  // evidence) and draft.rawDocuments <-> provenance.sourceDocuments (staged
  // raw refs). Counts must agree exactly; contents belong to staging.
  const provenance = mappedExam.provenance || {};
  compareField(
    mismatches,
    "provenance.evidence",
    (draft.edition.sources || []).length,
    Array.isArray(provenance.evidence) ? provenance.evidence.length : -1
  );
  compareField(
    mismatches,
    "provenance.sourceDocuments",
    (draft.rawDocuments || []).length,
    Array.isArray(provenance.sourceDocuments) ? provenance.sourceDocuments.length : -1
  );
  return { verificationPassed: mismatches.length === 0, mismatches };
}

async function publishSingleDraft({ EditionDraft, Receipt, ExamModel }, draftId, options = {}) {
  assertSingleDraftId(draftId);
  if (options.confirm !== true) {
    throw new Error("publishIntegration: explicit confirmation is required (pass { confirm: true }; dry-run otherwise)");
  }
  let result;
  try {
    result = await publishVerifiedDraft(EditionDraft, {
      Receipt,
      ExamModel,
      draftId,
      confirmPublish: true,
      publishedBy: options.publishedBy || null,
    });
  } catch (error) {
    return {
      publishSucceeded: false,
      stage: "PUBLISH_REJECTED",
      draftId: String(draftId),
      error: error.message,
      verificationPassed: false,
      mismatches: [],
    };
  }

  const stored = await ExamModel.findById(result.examId);
  if (!stored) {
    return {
      publishSucceeded: false,
      stage: "PUBLISH_REJECTED",
      draftId: result.draftId,
      publishedId: result.examId,
      error: "published record not found after write",
      verificationPassed: false,
      mismatches: [{ field: "record", expected: "present", actual: "missing" }],
    };
  }
  const draft = await EditionDraft.findById(result.draftId);
  const { verificationPassed, mismatches } = verifyPublishedRecord({
    stored,
    mappedExam: { ...result.exam, provenance: result.provenance },
    draft: draft && typeof draft.toObject === "function" ? draft.toObject() : draft,
    identity: result.identity,
  });
  return {
    publishSucceeded: verificationPassed,
    draftId: result.draftId,
    publishedId: result.examId,
    action: result.action,
    wrote: result.wrote,
    identity: result.identity,
    exam: result.exam,
    provenance: result.provenance,
    verificationPassed,
    mismatches,
  };
}

module.exports = {
  dryRunSingleDraft,
  publishSingleDraft,
  verifyPublishedRecord,
};
