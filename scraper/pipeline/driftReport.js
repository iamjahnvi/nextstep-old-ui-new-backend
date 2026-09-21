// =============================================================================
// scraper/pipeline/driftReport.js
// =============================================================================
// WHAT: Re-crawl drift report — MONITORING ONLY. Given an exam adapter, runs
//   the shared crawl sequence and reports each retrieved document as
//   NEW | UNCHANGED | CHANGED via checkDrift():
//     adapter
//       ↓  crawlSource (fetch → parse → discover → retrieve, same as ingestion)
//     checkDrift() per document (existing checksum/history mechanism)
//       ↓
//     drift report { NEW, UNCHANGED, CHANGED } — printed/returned summary.
// WHY: Operators need to see what moved on official sources before deciding
//   whether re-extraction or review is warranted. The report itself changes
//   nothing downstream: no extraction, no draft creation, no review,
//   verification, adjudication, promotion, or publishing is triggered here.
//   CHANGED/NEW documents are staged as new history by checkDrift (same as
//   any re-crawl); UNCHANGED documents store nothing new.
// SCOPE: reads the adapter config + staging collection only. Generic for all
//   adapters — no exam identity, no exam literals, no semantic diffing.
// CONTRACT:
//   runDriftReport(adapterConfig, { mongoUri })
//     adapterConfig : registry adapter object (validated against
//                     registry/schema.js; fail fast before any I/O).
//     mongoUri      : explicit URI, else process.env.MONGO_URI (same convention
//                     as server/config/db.js). Callers (tests) pass an isolated
//                     database URI so staging never touches production data.
//   Returns a print-safe summary:
//     { adapter, strategy, pageUrl, pageStatus, checked,
//       new, unchanged, changed, items[] }
//     items[] entries: { url, label, status, previousChecksum,
//       currentChecksum, previousFetchedAt, currentFetchedAt,
//       documentId, created } (timestamps ISO strings, null when absent).
// =============================================================================

const mongoose = require("mongoose");
const { SourceAdapterConfigSchema } = require("../registry/schema");
const { crawlSource } = require("./crawlSource");
const { getRawDocumentModel } = require("../models/rawDocument");
const { checkDrift } = require("../persistence/rawDocumentStore");

function toIso(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return null;
  return date.toISOString();
}

async function runDriftReport(adapterConfig, options = {}) {
  const adapter = SourceAdapterConfigSchema.parse(adapterConfig);

  const mongoUri = options.mongoUri || process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error(
      "driftReport: no MongoDB URI (pass options.mongoUri or set MONGO_URI)"
    );
  }

  const connection = await mongoose.createConnection(mongoUri).asPromise();
  try {
    const RawDocument = getRawDocumentModel(connection);
    const { landing, raws } = await crawlSource(adapter);

    const items = [];
    for (const raw of raws) {
      const drift = await checkDrift(RawDocument, raw);
      items.push({
        url: drift.url,
        label: drift.label,
        status: drift.status,
        previousChecksum: drift.previousChecksum,
        currentChecksum: drift.currentChecksum,
        previousFetchedAt: toIso(drift.previousFetchedAt),
        currentFetchedAt: toIso(drift.currentFetchedAt),
        documentId: drift.documentId,
        created: drift.created,
      });
    }

    const count = (status) => items.filter((item) => item.status === status).length;

    return {
      adapter: adapter.slug,
      strategy: adapter.render,
      pageUrl: landing.url,
      pageStatus: landing.status,
      checked: items.length,
      new: count("NEW"),
      unchanged: count("UNCHANGED"),
      changed: count("CHANGED"),
      items,
    };
  } finally {
    await connection.close();
  }
}

module.exports = {
  runDriftReport,
};
