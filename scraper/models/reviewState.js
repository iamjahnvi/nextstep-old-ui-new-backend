// =============================================================================
// scraper/models/reviewState.js
// =============================================================================
// WHAT: Mongoose schema for draft review states — "is this draft ready for
//   human inspection?" One document per staging draft, keyed by draftId, with
//   a history of past stages. Stages: DRAFT | REVIEW_REQUIRED |
//   READY_FOR_REVIEW. There is deliberately NO verified/published state here:
//   verification and publishing stay exclusively with pipeline/reviewPipeline
//   and publish/publishExecutor, which this module never imports or touches.
// WHY A SEPARATE COLLECTION: the draft's own status enum
//   (DRAFT/VERIFIED/REJECTED) is load-bearing for promotion guards and the
//   publish boundary. Review readiness is tracked beside the draft — never by
//   rewriting its status — so existing lifecycle behavior is byte-identical.
// ISOLATION: documents live in `scraper_review_states`. Nothing here imports
//   server code.
// WHY per-connection factory: same convention as the other staging models.
// =============================================================================

const mongoose = require("mongoose");

const REVIEW_STATE_COLLECTION = "scraper_review_states";
const DRAFT_REVIEW_STAGES = ["DRAFT", "REVIEW_REQUIRED", "READY_FOR_REVIEW"];

const historyEntrySchema = new mongoose.Schema(
  {
    stage: { type: String, required: true, enum: DRAFT_REVIEW_STAGES },
    decidedAt: { type: Date, required: true },
    itemCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const reviewStateSchema = new mongoose.Schema(
  {
    draftId: { type: String, required: true, trim: true, unique: true },
    examSlug: { type: String, default: null },
    stage: { type: String, required: true, enum: DRAFT_REVIEW_STAGES },
    items: { type: [Object], default: [] },
    decidedAt: { type: Date, required: true },
    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

function getReviewStateModel(connection, options = {}) {
  if (!connection || typeof connection.model !== "function") {
    throw new Error("getReviewStateModel: a mongoose connection is required");
  }
  const modelSchema = options.readOnly
    ? reviewStateSchema.clone().set("autoIndex", false).set("autoCreate", false)
    : reviewStateSchema;
  return connection.model("ScraperReviewState", modelSchema, REVIEW_STATE_COLLECTION);
}

module.exports = {
  REVIEW_STATE_COLLECTION,
  DRAFT_REVIEW_STAGES,
  reviewStateSchema,
  getReviewStateModel,
};
