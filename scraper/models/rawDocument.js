// =============================================================================
// scraper/models/rawDocument.js
// =============================================================================
// WHAT: Mongoose schema for scraper staging persistence — fetched source
//   documents (RawDocuments), exactly as retrieved. This is RAW-SOURCE storage
//   only: no eligibility/dates/syllabus extraction lives here.
// ISOLATION: documents live in the `scraper_rawdocuments` collection, which is
//   unrelated to NextStep's production `exams` collection. Nothing in the
//   scraper ever reads or writes the Exam model.
// WHY per-connection factory: the pipeline opens its own connection (same
//   MONGO_URI convention as server/config/db.js) and must not clash with host
//   app models — getRawDocumentModel(connection) registers once per connection.
// =============================================================================

const mongoose = require("mongoose");

const RAW_DOCUMENT_TYPES = ["HTML", "PDF", "OTHER"];

const rawDocumentSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    sourceUrl: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    type: { type: String, required: true, enum: RAW_DOCUMENT_TYPES },
    contentType: { type: String, default: null },
    fetchedAt: { type: Date, required: true },
    // Numeric HTTP status where the fetch strategy provides one (may be null
    // for strategies/transports without a status, e.g. some browser flows).
    status: { type: Number, default: null },
    // SHA-256 hex of the stored bytes (crypto, see persistence layer).
    checksum: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    // Polymorphic by `type`: Buffer for PDF, string for HTML/OTHER.
    // NOTE: Mixed paths have no read casting, so the driver returns BSON
    // Binary for stored Buffers; the getter below converts it back to Buffer
    // on hydrated documents. Lean (.lean()) reads skip getters — normalize
    // those with normalizeReadContent() from persistence/rawDocumentStore.js.
    content: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      get: (value) =>
        value && value._bsontype === "Binary"
          ? Buffer.from(value.buffer)
          : value,
    },
  },
  { timestamps: true }
  // createdAt = first-stored time of this (url, checksum) pair. History is
  // preserved: a changed source stores a NEW document, never overwrites.
);

// Dedup key: the same unchanged source is recognized, not re-stored.
rawDocumentSchema.index({ url: 1, checksum: 1 }, { unique: true });
rawDocumentSchema.index({ sourceUrl: 1 });
rawDocumentSchema.index({ label: 1 });

function getRawDocumentModel(connection) {
  if (!connection || typeof connection.model !== "function") {
    throw new Error("getRawDocumentModel: a mongoose connection is required");
  }
  return connection.model(
    "ScraperRawDocument",
    rawDocumentSchema,
    "scraper_rawdocuments"
  );
}

module.exports = {
  RAW_DOCUMENT_TYPES,
  rawDocumentSchema,
  getRawDocumentModel,
};
