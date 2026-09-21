// =============================================================================
// scraper/pipeline/ingestionPipeline.js
// =============================================================================
// WHAT: Generic staging ingestion pipeline — the ONLY place persistence is
//   attached to the shared crawl sequence:
//     crawlSource (fetch source page → parse HTML → discover documents
//       → retrieve via fetchers/documentFetcher)
//     → validate + checksum → persist to the scraper staging collection.
// WHY: The pipeline owns persistence policy and nothing else. Fetching,
//   discovery, retrieval, politeness each live in their own module and are
//   reused here — nothing is duplicated. The pipeline reads the registry
//   adapter config, so adding a source means adding config, never branches.
// SCOPE: raw-source persistence ONLY. No eligibility/date/syllabus/application
//   extraction, no Exam/ExamEdition writes, no scheduling.
// CONTRACT:
//   runIngestionPipeline(adapterConfig, { mongoUri })
//     adapterConfig : registry adapter object (validated against
//                     registry/schema.js; fail fast before any I/O).
//     mongoUri      : explicit URI, else process.env.MONGO_URI (same convention
//                     as server/config/db.js). Callers (tests) pass an isolated
//                     database URI so staging never touches production data.
//   Returns a print-safe summary:
//     { adapter, strategy, pageUrl, pageStatus, discovered, stored, results[] }
//     results[] entries: { label, url, type, status, checksum, created, id }.
// =============================================================================

const mongoose = require("mongoose");
const { SourceAdapterConfigSchema } = require("../registry/schema");
const { crawlSource } = require("./crawlSource");
const { getRawDocumentModel } = require("../models/rawDocument");
const { saveRawDocument } = require("../persistence/rawDocumentStore");

async function runIngestionPipeline(adapterConfig, options = {}) {
  const adapter = SourceAdapterConfigSchema.parse(adapterConfig);

  const mongoUri = options.mongoUri || process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error(
      "ingestionPipeline: no MongoDB URI (pass options.mongoUri or set MONGO_URI)"
    );
  }

  const connection = await mongoose.createConnection(mongoUri).asPromise();
  try {
    const RawDocument = getRawDocumentModel(connection);
    const { landing, raws } = await crawlSource(adapter);

    const results = [];
    for (const raw of raws) {
      const { document, created } = await saveRawDocument(RawDocument, raw);
      results.push({
        label: raw.label,
        url: raw.url,
        type: raw.type,
        status: raw.status,
        checksum: document.checksum,
        created,
        id: String(document._id),
      });
    }

    return {
      adapter: adapter.slug,
      strategy: adapter.render,
      pageUrl: landing.url,
      pageStatus: landing.status,
      discovered: raws.length,
      stored: results.filter((r) => r.created).length,
      results,
    };
  } finally {
    await connection.close();
  }
}

module.exports = {
  runIngestionPipeline,
};
