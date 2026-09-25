// =============================================================================
// scraper/models/sourceProfile.js
// =============================================================================
// WHAT: Mongoose schema for source verification + technical profiling results
//   — "what do we know about this candidate's source?" One document per
//   candidateId. Verification and profile are independent subdocuments saved by
//   different steps (verification may run without profiling and vice versa);
//   neither subdocument touches the candidate's own status except through the
//   explicit applyVerification path in discovery/sourceVerification.js.
// ISOLATION: documents live in the `scraper_source_profiles` collection —
//   separate from `scraper_exam_candidates`, `scraper_editiondrafts`, and
//   production `exams`. Nothing here imports server code.
// WHY per-connection factory: same convention as the other staging models.
// =============================================================================

const mongoose = require("mongoose");

const SOURCE_PROFILE_COLLECTION = "scraper_source_profiles";

const VERIFICATION_STATUSES = ["SOURCE_VERIFIED", "SOURCE_REVIEW_REQUIRED"];
const SIGNAL_RESULTS = ["match", "mismatch", "unknown", "supporting"];
const PROFILE_TYPES = ["STATIC_HTML", "JAVASCRIPT_HTML", "PDF", "MIXED", "UNKNOWN"];
const TRANSPORT_TYPES = ["HTTP", "BROWSER", "UNKNOWN"];
const DOCUMENT_TYPES = ["HTML", "PDF", "MIXED", "UNKNOWN"];

// One evaluated signal: never a bare boolean — the detail explains the call.
const verificationSignalSchema = new mongoose.Schema(
  {
    signal: { type: String, required: true, trim: true },
    result: { type: String, required: true, enum: SIGNAL_RESULTS },
    detail: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const verificationSchema = new mongoose.Schema(
  {
    status: { type: String, required: true, enum: VERIFICATION_STATUSES },
    reason: { type: String, required: true, trim: true },
    signals: { type: [verificationSignalSchema], default: [] },
    decidedAt: { type: Date, required: true },
    decidedBy: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const profileSignalSchema = new mongoose.Schema(
  {
    signal: { type: String, required: true, trim: true },
    detail: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const profileSchema = new mongoose.Schema(
  {
    // null requiresJavaScript = unknown (neither true nor false evidenced).
    type: { type: String, required: true, enum: PROFILE_TYPES },
    transport: { type: String, required: true, enum: TRANSPORT_TYPES },
    documentTypes: { type: String, required: true, enum: DOCUMENT_TYPES },
    requiresJavaScript: { type: Boolean, default: null },
    signals: { type: [profileSignalSchema], default: [] },
    profiledAt: { type: Date, required: true },
    profiler: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const sourceProfileSchema = new mongoose.Schema(
  {
    candidateId: { type: String, required: true, trim: true, unique: true },
    sourceUrl: { type: String, required: true, trim: true },
    sourceDomain: { type: String, required: true, trim: true },
    verification: { type: verificationSchema, default: null },
    profile: { type: profileSchema, default: null },
    review: {
      required: { type: Boolean, default: true },
      reasons: { type: [String], default: [] },
    },
  },
  { timestamps: true }
);

sourceProfileSchema.index({ sourceDomain: 1 });

function getSourceProfileModel(connection) {
  if (!connection || typeof connection.model !== "function") {
    throw new Error("getSourceProfileModel: a mongoose connection is required");
  }
  return connection.model(
    "ScraperSourceProfile",
    sourceProfileSchema,
    SOURCE_PROFILE_COLLECTION
  );
}

module.exports = {
  SOURCE_PROFILE_COLLECTION,
  VERIFICATION_STATUSES,
  SIGNAL_RESULTS,
  PROFILE_TYPES,
  TRANSPORT_TYPES,
  DOCUMENT_TYPES,
  sourceProfileSchema,
  getSourceProfileModel,
};
