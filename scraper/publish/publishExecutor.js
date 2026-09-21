// =============================================================================
// scraper/publish/publishExecutor.js
// =============================================================================
// WHAT: Manual production publish executor — the ONLY place a VERIFIED staging
//   draft may become a production Exam record:
//     dryRunPublish(...)      → describes the publish, writes NOTHING (default)
//     publishVerifiedDraft(...) → writes ONLY with { confirmPublish: true }.
// WHY: Publishing must never happen accidentally. The default path is
//   read-only; the write path demands an explicit flag, re-validates
//   everything, and converges on one record per publish identity.
// REUSES (never duplicated): examMapper.js (mapping), publishValidator.js
//   (payload validation), publishService.js (VERIFIED-gated payload build).
// IDENTITY (no name matching, no fuzzy logic): the stable publish identity
//   is `examSlug:year:cycle` from the VERIFIED draft. A staging-side receipt
//   (models/publishReceipt.js, unique on identity) maps it to the production
//   Exam _id. Same draft twice → same receipt, no duplicate. A different
//   draft claiming an already-published identity → loud identity-conflict
//   error (never an overwrite, never a guess). A receipt pointing at a
//   missing Exam (deleted out-of-band) is unresolvable → loud failure.
// DEMO-DATA SAFETY: exactly one production document is ever touched —
//   created via Model.create(payload) for a fresh identity, or left alone for
//   an already-published one. No deletes, no reseeds, no bulk writes, no
//   updates to unrelated records (not even on name match).
// TARGET GUARDS: the production model must back EXACTLY the existing
//   NextStep Exam collection ("exams"). Staging collections (scraper_*),
//   demo/seed collections, and any other name are refused. The executor never
//   requires server/models/Exam.js itself — the caller supplies the model
//   (production wiring passes the real one; tests pass an isolated stand-in
//   on a throwaway database). Connection strings follow the project's
//   MONGO_URI convention via the caller's models; nothing is hardcoded here.
// CONTRACT:
//   dryRunPublish(EditionDraft, { Receipt, ExamModel?, draftId })
//     Read-only. Returns { dryRun: true, wrote: false, draftId, identity,
//       action: "would-create" | "already-published", exam, provenance }.
//   publishVerifiedDraft(EditionDraft, { Receipt, ExamModel, draftId,
//     confirmPublish?, publishedBy? })
//     Without confirmPublish: true → identical to dryRunPublish (no write).
//     With it → { dryRun: false, wrote, action: "created" |
//       "already-published", examId, identity }.
// =============================================================================

const {
  EDITION_DRAFT_COLLECTION,
} = require("../models/examEditionDraft");
const {
  PUBLISH_RECEIPT_COLLECTION,
} = require("../models/publishReceipt");
const { buildPublishPayloadFromDraft } = require("./publishService");

// The one and only production target: the existing NextStep Exam collection.
const PRODUCTION_EXAM_COLLECTION = "exams";

function assertStagingDraftModel(EditionDraft) {
  if (!EditionDraft || !EditionDraft.collection) {
    throw new Error("publishExecutor: a staging draft model is required");
  }
  if (EditionDraft.collection.name !== EDITION_DRAFT_COLLECTION) {
    throw new Error(
      `publishExecutor: refusing to read drafts from "${EditionDraft.collection.name}" ` +
        `(staging drafts live in "${EDITION_DRAFT_COLLECTION}")`
    );
  }
}

function assertReceiptModel(Receipt) {
  if (!Receipt || !Receipt.collection) {
    throw new Error("publishExecutor: a publish receipt model is required");
  }
  if (Receipt.collection.name !== PUBLISH_RECEIPT_COLLECTION) {
    throw new Error(
      `publishExecutor: refusing to track receipts in "${Receipt.collection.name}" ` +
        `(receipts live in "${PUBLISH_RECEIPT_COLLECTION}")`
    );
  }
}

// Production target allow-list: exactly "exams". Everything else — staging
// collections, seed/demo collections, arbitrary names — is refused.
function assertProductionExamModel(ExamModel) {
  if (!ExamModel || !ExamModel.collection) {
    throw new Error("publishExecutor: a production Exam model is required");
  }
  if (ExamModel.collection.name !== PRODUCTION_EXAM_COLLECTION) {
    throw new Error(
      `publishExecutor: refusing to publish into "${ExamModel.collection.name}" ` +
        `(production target must be exactly "${PRODUCTION_EXAM_COLLECTION}")`
    );
  }
}

function toPlain(draft) {
  return draft && typeof draft.toObject === "function"
    ? draft.toObject()
    : draft;
}

// Stable publish identity — edition-derived, never name-derived.
function buildPublishIdentity(draft) {
  const plain = toPlain(draft);
  const edition = plain && plain.edition;
  if (!edition || !edition.examSlug || !edition.year || !edition.cycle) {
    throw new Error(
      "publishExecutor: publish identity is missing (examSlug/year/cycle required)"
    );
  }
  return `${edition.examSlug}:${edition.year}:${edition.cycle}`;
}

function isDuplicateKeyError(error) {
  return error && (error.code === 11000 || error.code === 11001);
}

async function loadVerifiedDraft(EditionDraft, draftId) {
  if (!draftId) throw new Error("publishExecutor: draftId is required");
  const draft = await EditionDraft.findById(draftId);
  if (!draft) throw new Error("publishExecutor: draft not found");
  return draft;
}

// Shared read-only core: loads the draft, enforces VERIFIED, maps and
// validates. Both dry-run and confirmed publish start here, so the write
// path can never skip validation.
async function describePublish(EditionDraft, Receipt, draftId) {
  assertStagingDraftModel(EditionDraft);
  assertReceiptModel(Receipt);
  const draft = await loadVerifiedDraft(EditionDraft, draftId);
  const { exam, provenance } = buildPublishPayloadFromDraft(draft);
  const identity = buildPublishIdentity(draft);
  const receipt = await Receipt.findOne({ identity });
  return { draft: toPlain(draft), exam, provenance, identity, receipt };
}

// dryRunPublish — default entry point. Read-only by construction: this
// function contains no write call, only reads.
async function dryRunPublish(EditionDraft, { Receipt, draftId } = {}) {
  const { exam, provenance, identity, receipt } = await describePublish(
    EditionDraft,
    Receipt,
    draftId
  );
  return {
    dryRun: true,
    wrote: false,
    draftId: provenance.draftId,
    identity,
    target: PRODUCTION_EXAM_COLLECTION,
    action: receipt ? "already-published" : "would-create",
    existingExamId: receipt ? String(receipt.examId) : null,
    exam,
    provenance,
    validation: { ok: true },
  };
}

async function publishVerifiedDraft(
  EditionDraft,
  { Receipt, ExamModel, draftId, confirmPublish = false, publishedBy = null } = {}
) {
  assertStagingDraftModel(EditionDraft);
  assertReceiptModel(Receipt);

  // Default (and any falsy flag): dry-run. No write is possible on this path.
  if (confirmPublish !== true) {
    return dryRunPublish(EditionDraft, { Receipt, draftId });
  }

  assertProductionExamModel(ExamModel);
  const { draft, exam, provenance, identity } = await describePublish(
    EditionDraft,
    Receipt,
    draftId
  );

  // Idempotency: an identity already published resolves to its receipt.
  const existing = await Receipt.findOne({ identity });
  if (existing) {
    if (String(existing.draftId) !== String(draft._id)) {
      throw new Error(
        `publishExecutor: identity conflict — "${identity}" was already ` +
          `published by a different draft (refusing to overwrite)`
      );
    }
    const target = await ExamModel.findById(existing.examId);
    if (!target) {
      throw new Error(
        `publishExecutor: identity conflict — receipt for "${identity}" ` +
          `points at a missing Exam record (refusing to guess)`
      );
    }
    return {
      dryRun: false,
      wrote: false,
      action: "already-published",
      draftId: provenance.draftId,
      identity,
      examId: String(target._id),
      exam,
      provenance,
    };
  }

  // Fresh identity: create exactly one Exam, then record the receipt. A
  // duplicate-key race on the unique identity converges on the winner.
  let created;
  try {
    created = await ExamModel.create(exam);
  } catch (error) {
    throw new Error(`publishExecutor: production create failed — ${error.message}`);
  }
  try {
    await Receipt.create({
      identity,
      draftId: draft._id,
      examSlug: draft.edition.examSlug,
      year: draft.edition.year,
      cycle: draft.edition.cycle,
      examId: created._id,
      publishedAt: new Date(),
      publishedBy,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // Lost the race: another publish won this identity. Roll back our
      // orphan create so no duplicate survives, then resolve like a republish.
      await ExamModel.deleteOne({ _id: created._id });
      const winner = await Receipt.findOne({ identity });
      if (!winner || String(winner.draftId) !== String(draft._id)) {
        throw new Error(
          `publishExecutor: identity conflict — "${identity}" was published ` +
            `concurrently by another draft (refusing to overwrite)`
        );
      }
      return {
        dryRun: false,
        wrote: false,
        action: "already-published",
        draftId: provenance.draftId,
        identity,
        examId: String(winner.examId),
        exam,
        provenance,
      };
    }
    // Non-key failure after the Exam create: remove the orphan so staging and
    // production cannot disagree, then fail loudly.
    await ExamModel.deleteOne({ _id: created._id });
    throw new Error(`publishExecutor: receipt write failed — ${error.message}`);
  }

  return {
    dryRun: false,
    wrote: true,
    action: "created",
    draftId: provenance.draftId,
    identity,
    examId: String(created._id),
    exam,
    provenance,
  };
}

module.exports = {
  PRODUCTION_EXAM_COLLECTION,
  buildPublishIdentity,
  dryRunPublish,
  publishVerifiedDraft,
  assertStagingDraftModel,
  assertReceiptModel,
  assertProductionExamModel,
};
