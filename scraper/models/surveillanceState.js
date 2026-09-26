// =============================================================================
// scraper/models/surveillanceState.js
// =============================================================================
// WHAT: Mongoose schema for source-surveillance tracking — "what did this
//   source look like at each check?" One document per (candidateId,
//   sourceUrl), holding the baseline, an append-only check history, and the
//   latest comparison. History is never rewritten: each run appends its
//   snapshot, so previous evidence survives every future check.
// ISOLATION: documents live in the `scraper_surveillance_states` collection —
//   separate from candidates, drafts, review states, and production `exams`.
//   Nothing here imports server code.
// WHY per-connection factory: same convention as the other staging models.
// =============================================================================

const mongoose = require("mongoose");

const SURVEILLANCE_STATE_COLLECTION = "scraper_surveillance_states";
const SURVEILLANCE_OUTCOMES = ["NO_ACTION", "REVIEW_REQUIRED", "FAILED", "BASELINE"];

const snapshotSchema = new mongoose.Schema(
  {
    sourceUrl: { type: String, default: null },
    documentUrl: { type: String, default: null },
    contentHash: { type: String, default: null },
    revision: { type: Boolean, default: false },
    evidenceExcerpts: { type: [String], default: [] },
    // Opaque carried value (whatever the caller observed — a hash, a date
    // string, null). Surveillance never interprets it, only compares it.
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const checkEntrySchema = new mongoose.Schema(
  {
    checkedAt: { type: Date, required: true },
    outcome: { type: String, required: true, enum: SURVEILLANCE_OUTCOMES },
    triggers: { type: [String], default: [] },
    snapshot: { type: snapshotSchema, default: null },
  },
  { _id: false }
);

const surveillanceStateSchema = new mongoose.Schema(
  {
    candidateId: { type: String, required: true, trim: true },
    sourceUrl: { type: String, required: true, trim: true },
    sourceDomain: { type: String, default: null },
    baseline: { type: snapshotSchema, default: null },
    history: { type: [checkEntrySchema], default: [] },
    lastOutcome: { type: String, default: null },
    reviewStateKey: { type: String, default: null },
  },
  { timestamps: true }
);

surveillanceStateSchema.index({ candidateId: 1, sourceUrl: 1 }, { unique: true });
surveillanceStateSchema.index({ lastOutcome: 1 });

function getSurveillanceStateModel(connection, options = {}) {
  if (!connection || typeof connection.model !== "function") {
    throw new Error("getSurveillanceStateModel: a mongoose connection is required");
  }
  const modelSchema = options.readOnly
    ? surveillanceStateSchema.clone().set("autoIndex", false).set("autoCreate", false)
    : surveillanceStateSchema;
  return connection.model(
    "ScraperSurveillanceState",
    modelSchema,
    SURVEILLANCE_STATE_COLLECTION
  );
}

module.exports = {
  SURVEILLANCE_STATE_COLLECTION,
  SURVEILLANCE_OUTCOMES,
  surveillanceStateSchema,
  getSurveillanceStateModel,
};
