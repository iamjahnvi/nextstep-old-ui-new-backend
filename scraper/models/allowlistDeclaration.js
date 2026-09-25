// =============================================================================
// scraper/models/allowlistDeclaration.js
// =============================================================================
// WHAT: Mongoose schema for operator-owned bulletin-allowlist declarations —
//   the explicit, auditable layer between an adapter's static bulletinUrls and
//   Step 23 freshness checks. One document per adapter slug: the effective
//   URL list, retired URLs, and an append-only resolutions audit trail.
//   Adapter JS files are never edited at runtime; this staging record IS the
//   operator decision, versioned per resolution.
// ISOLATION: documents live in the `scraper_allowlist_declarations`
//   collection — separate from candidates, drafts, review states, raw
//   documents, and production `exams`. Nothing here imports server code.
// WHY per-connection factory: same convention as the other staging models.
// =============================================================================

const mongoose = require("mongoose");

const ALLOWLIST_DECLARATION_COLLECTION = "scraper_allowlist_declarations";
const ALLOWLIST_DECISIONS = ["UPDATE", "RETIRE"];

const resolutionSchema = new mongoose.Schema(
  {
    reviewId: { type: String, required: true, trim: true },
    candidateId: { type: String, required: true, trim: true },
    decision: { type: String, required: true, enum: ALLOWLIST_DECISIONS },
    operator: { type: String, required: true, trim: true },
    oldUrl: { type: String, required: true, trim: true },
    newUrl: { type: String, default: null },
    reason: { type: String, required: true, trim: true },
    evidence: { type: mongoose.Schema.Types.Mixed, default: null },
    timestamp: { type: Date, required: true },
  },
  { _id: false }
);

const allowlistDeclarationSchema = new mongoose.Schema(
  {
    adapterSlug: { type: String, required: true, trim: true, unique: true },
    urls: { type: [String], default: [] },
    retired: { type: [String], default: [] },
    resolutions: { type: [resolutionSchema], default: [] },
  },
  { timestamps: true }
);

function getAllowlistDeclarationModel(connection) {
  if (!connection || typeof connection.model !== "function") {
    throw new Error("getAllowlistDeclarationModel: a mongoose connection is required");
  }
  return connection.model(
    "ScraperAllowlistDeclaration",
    allowlistDeclarationSchema,
    ALLOWLIST_DECLARATION_COLLECTION
  );
}

module.exports = {
  ALLOWLIST_DECLARATION_COLLECTION,
  ALLOWLIST_DECISIONS,
  allowlistDeclarationSchema,
  getAllowlistDeclarationModel,
};
