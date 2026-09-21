// =============================================================================
// scraper/models/examEditionDraft.js
// =============================================================================
// WHAT: Mongoose schema for persistent extracted ExamEdition drafts — the
//   review/promotion layer's storage. Holds the normalized Phase 5 output
//   (exam identity + edition data), workflow status, evidence/provenance and
//   source RawDocument references.
// ISOLATION: documents live in the `scraper_editiondrafts` collection, which
//   is unrelated to NextStep's production `exams` collection and to
//   server/data/exams.js. Nothing here imports server code, and the review
//   service refuses to operate on any other collection (see
//   pipeline/reviewPipeline.js assertStagingDraftModel).
// STATUS: DRAFT -> VERIFIED | REJECTED. Terminal states never transition.
//   History is preserved: re-extraction saves a NEW draft, never overwrites.
// ADJUDICATIONS: operator decisions on UNKNOWN-with-evidence axes (Phase 13)
//   live in the top-level `adjudications` array — deliberately OUTSIDE
//   exam/edition, which are strict-validated and must keep their exact shape.
//   Each entry records axis, decision, value, who/when, and an optional note.
// WHY per-connection factory: same convention as models/rawDocument.js — the
//   service opens its own connection and must not clash with host app models.
// =============================================================================

const mongoose = require("mongoose");

const EDITION_DRAFT_COLLECTION = "scraper_editiondrafts";
const DRAFT_STATUSES = ["DRAFT", "VERIFIED", "REJECTED"];
const ADJUDICATION_DECISIONS = ["CONFIRM_VALUE", "KEEP_UNKNOWN"];

const rawDocumentRefSchema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    url: { type: String, required: true, trim: true },
    checksum: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    label: { type: String, default: null },
  },
  { _id: false }
);

// One operator decision on one UNKNOWN axis. Stored outside exam/edition so
// strict validation of the extracted shapes is never polluted.
const adjudicationSchema = new mongoose.Schema(
  {
    axis: { type: String, required: true, trim: true },
    decision: { type: String, required: true, enum: ADJUDICATION_DECISIONS },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    decidedBy: { type: String, required: true, trim: true },
    decidedAt: { type: Date, required: true },
    note: { type: String, default: null },
  },
  { _id: false }
);

const examEditionDraftSchema = new mongoose.Schema(
  {
    examSlug: { type: String, required: true, trim: true },
    year: { type: Number, required: true },
    cycle: { type: String, required: true, trim: true },
    // Normalized Phase 5 output, exactly as validated by
    // validators/examValidator.js. Stored as Objects (Mixed would also lose
    // no fidelity, but Object keeps top-level shape explicit). Field-level
    // truth lives in the zod schemas, not here — this layer persists.
    exam: { type: Object, required: true },
    edition: { type: Object, required: true },
    status: { type: String, required: true, enum: DRAFT_STATUSES, default: "DRAFT" },
    // Source RawDocument references (identity snapshots, not live refs —
    // promotion must never modify the RawDocuments themselves).
    rawDocuments: { type: [rawDocumentRefSchema], default: [] },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: String, default: null },
    rejectReason: { type: String, default: null },
    adjudications: { type: [adjudicationSchema], default: [] },
  },
  { timestamps: true }
  // createdAt = draft-saved time. updatedAt changes on review transitions.
  // No unique key: re-extraction of the same (examSlug, year, cycle) saves a
  // NEW draft so review history is never lost.
);

examEditionDraftSchema.index({ examSlug: 1, year: 1, cycle: 1 });
examEditionDraftSchema.index({ status: 1 });

function getExamEditionDraftModel(connection) {
  if (!connection || typeof connection.model !== "function") {
    throw new Error("getExamEditionDraftModel: a mongoose connection is required");
  }
  return connection.model(
    "ScraperExamEditionDraft",
    examEditionDraftSchema,
    EDITION_DRAFT_COLLECTION
  );
}

module.exports = {
  EDITION_DRAFT_COLLECTION,
  DRAFT_STATUSES,
  ADJUDICATION_DECISIONS,
  examEditionDraftSchema,
  getExamEditionDraftModel,
};
