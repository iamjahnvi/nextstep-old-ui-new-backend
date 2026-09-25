// =============================================================================
// scraper/operations/backup.js — STEP 14 backup and restore support
// =============================================================================
// WHAT: Operational backup primitives for MongoDB-held scraper state.
//   backupPlan() states what is covered; exportSnapshot() writes read-only
//   JSON exports per collection into a directory; verifyBackup() re-reads an
//   export and reports parse/count integrity. Restore itself stays a
//   DOCUMENTED manual procedure (mongorestore, see DEPLOYMENT.md) — this
//   module never writes to a database, never deletes anything, and never
//   prunes. Destructive cleanup lives exclusively behind Step 13 retention's
//   explicit confirm+actor gate.
// WHY: Staging holds provenance, drafts, receipts, and review history that
//   must survive host failure. Exports are JSON (inspectable, diffable) and
//   cover every scraper collection plus production `exams` when the caller
//   includes it — inclusion is explicit, never assumed.
// COVERAGE (default): scraper_rawdocuments, scraper_editiondrafts,
//   scraper_publish_receipts, scraper_exam_candidates, scraper_source_profiles,
//   scraper_review_states, scraper_surveillance_states, scraper_operation_runs.
// CONTRACT:
//   backupPlan(collections?) -> { collections, format, note } (pure).
//   exportSnapshot({ connection, collections?, dir }) -> { dir, files:
//     [{ collection, file, documents }] } — read-only source, one
//     "<collection>.json" per collection. Throws on missing dir/connection.
//   verifyBackup(dir, collections?) -> { ok, files: [{ collection, file,
//     documents, parseable }] } — ok false on any missing/unparseable file.
// GENERICITY: counts and bytes only. No exam logic.
// =============================================================================

const fs = require("fs");
const path = require("path");

const BACKUP_COLLECTIONS = [
  "scraper_rawdocuments",
  "scraper_editiondrafts",
  "scraper_publish_receipts",
  "scraper_exam_candidates",
  "scraper_source_profiles",
  "scraper_review_states",
  "scraper_surveillance_states",
  "scraper_operation_runs",
];

function backupPlan(collections = BACKUP_COLLECTIONS) {
  const list = Array.isArray(collections) ? [...collections] : [...BACKUP_COLLECTIONS];
  if (list.length === 0) {
    throw new Error("backup: at least one collection is required");
  }
  return {
    collections: list,
    format: "json-array-per-collection",
    note: "read-only export; restore via mongorestore per DEPLOYMENT.md (manual, operator-run)",
  };
}

async function exportSnapshot({ connection, collections, dir } = {}) {
  if (!connection || typeof connection !== "object" || !connection.db) {
    throw new Error("backup: a database connection is required");
  }
  if (typeof dir !== "string" || !dir) {
    throw new Error("backup: a destination dir is required");
  }
  const plan = backupPlan(collections);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const collection of plan.collections) {
    const documents = await connection.db.collection(collection).find({}).toArray();
    const file = path.join(dir, `${collection}.json`);
    fs.writeFileSync(file, JSON.stringify(documents));
    files.push({ collection, file, documents: documents.length });
  }
  return { dir, files };
}

function verifyBackup(dir, collections = BACKUP_COLLECTIONS) {
  if (typeof dir !== "string" || !dir) {
    throw new Error("backup: a backup dir is required");
  }
  const plan = backupPlan(collections);
  const files = [];
  let ok = true;
  for (const collection of plan.collections) {
    const file = path.join(dir, `${collection}.json`);
    let documents = 0;
    let parseable = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) {
        parseable = true;
        documents = parsed.length;
      } else {
        ok = false;
      }
    } catch {
      ok = false;
    }
    files.push({ collection, file, documents, parseable });
    if (!parseable) ok = false;
  }
  return { ok, files };
}

module.exports = {
  BACKUP_COLLECTIONS,
  backupPlan,
  exportSnapshot,
  verifyBackup,
};
