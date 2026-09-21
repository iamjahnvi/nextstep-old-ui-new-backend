// =============================================================================
// scraper/models/publishReceipt.js
// =============================================================================
// WHAT: Staging-side publish receipts — the idempotency record for manual
//   production publishes. One receipt per publish identity; the unique index
//   makes double-publish (including races) converge instead of duplicating.
// WHY receipts instead of a production identity field: the existing NextStep
//   Exam model has no stable external-identity field, and Phase 8 must NOT
//   redesign it. The smallest safe mechanism is therefore a staging-side map:
//     publish identity (examSlug:year:cycle) → production Exam _id + draftId.
//   Production stays untouched structurally; all publish bookkeeping lives in
//   scraper staging (`scraper_publish_receipts`, alongside the drafts).
// WHY per-connection factory: same convention as the other staging models.
// =============================================================================

const mongoose = require("mongoose");

const PUBLISH_RECEIPT_COLLECTION = "scraper_publish_receipts";

const publishReceiptSchema = new mongoose.Schema(
  {
    // Stable publish identity, e.g. "jee-main:2026:2026" — derived from the
    // VERIFIED draft's edition, never from a fuzzy name match.
    identity: { type: String, required: true, trim: true, unique: true },
    draftId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    examSlug: { type: String, required: true, trim: true },
    year: { type: Number, required: true },
    cycle: { type: String, required: true, trim: true },
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    publishedAt: { type: Date, required: true },
    publishedBy: { type: String, default: null },
  },
  { timestamps: true }
);

function getPublishReceiptModel(connection) {
  if (!connection || typeof connection.model !== "function") {
    throw new Error("getPublishReceiptModel: a mongoose connection is required");
  }
  return connection.model(
    "ScraperPublishReceipt",
    publishReceiptSchema,
    PUBLISH_RECEIPT_COLLECTION
  );
}

module.exports = {
  PUBLISH_RECEIPT_COLLECTION,
  publishReceiptSchema,
  getPublishReceiptModel,
};
