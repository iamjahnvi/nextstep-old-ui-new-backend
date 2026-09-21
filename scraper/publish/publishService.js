// =============================================================================
// scraper/publish/publishService.js
// =============================================================================
// WHAT: Controlled publish boundary — turns a VERIFIED staging draft into a
//   VALIDATED, in-memory publish payload:
//     load VERIFIED draft → map (examMapper) → validate (publishValidator)
//     → return { exam, provenance }.
// WHAT IT IS NOT: there is deliberately NO database publish here. This module
//   never calls .save()/.create()/.update() on anything, never requires
//   server/models/Exam.js, server/data/exams.js or seed scripts, and performs
//   no merge/conflict resolution (a name match never overwrites anything —
//   identity travels in `provenance`, and the actual production write is a
//   clearly separated future step, not a hidden flag).
// CONTRACT:
//   buildPublishPayload(EditionDraftModel, draftId)
//     Loads the draft from staging (collection-guarded: refuses anything but
//     scraper_editiondrafts), requires VERIFIED, maps + validates.
//     Returns { exam, provenance } — in-memory only.
//     Throws a clear error for: missing draft, non-VERIFIED status, mapping
//     failure, or payload validation failure (issues attached as JSON).
//   buildPublishPayloadFromDraft(draftObject) — same, for a pre-loaded draft
//     (pure, no I/O; unit tests use this).
// =============================================================================

const {
  EDITION_DRAFT_COLLECTION,
} = require("../models/examEditionDraft");
const { mapDraftToExamPayload } = require("./examMapper");
const { validatePublishRequest } = require("./publishValidator");

function assertStagingDraftModel(EditionDraft) {
  if (!EditionDraft || !EditionDraft.collection) {
    throw new Error("publishService: a draft model is required");
  }
  if (EditionDraft.collection.name !== EDITION_DRAFT_COLLECTION) {
    throw new Error(
      `publishService: refusing to operate on collection "${EditionDraft.collection.name}" ` +
        `(staging drafts live in "${EDITION_DRAFT_COLLECTION}")`
    );
  }
}

function toPlain(draft) {
  return draft && typeof draft.toObject === "function"
    ? draft.toObject()
    : draft;
}

// Pure core: no I/O, no writes — safe to unit test without a database.
function buildPublishPayloadFromDraft(draft) {
  if (!draft) throw new Error("publishService: draft not found");
  const plain = toPlain(draft);
  const { exam, provenance } = mapDraftToExamPayload(plain);
  const check = validatePublishRequest({ draft: plain, payload: exam });
  if (!check.ok) {
    throw new Error(
      "publishService: payload rejected — " +
        JSON.stringify(check.issues, null, 2)
    );
  }
  return { exam: check.value, provenance };
}

async function buildPublishPayload(EditionDraft, draftId) {
  assertStagingDraftModel(EditionDraft);
  if (!draftId) throw new Error("publishService: draftId is required");
  const draft = await EditionDraft.findById(draftId);
  if (!draft) throw new Error("publishService: draft not found");
  return buildPublishPayloadFromDraft(draft);
}

module.exports = {
  buildPublishPayload,
  buildPublishPayloadFromDraft,
  assertStagingDraftModel,
};
