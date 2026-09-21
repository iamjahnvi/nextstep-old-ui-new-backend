// =============================================================================
// scraper/persistence/rawDocumentStore.js
// =============================================================================
// WHAT: Small persistence layer for RawDocuments: checksum + deduped save +
//   drift detection. Re-running the scraper must not blindly duplicate the
//   exact same bytes, and re-crawls must be able to report what changed.
// WHY: Identity is (url, checksum): an unchanged source returns the existing
//   record ({ created: false }); changed bytes store a NEW record — history is
//   never deleted here (no versioning of Exam/ExamEdition in this phase).
//   checkDrift() layers NEW | UNCHANGED | CHANGED reporting on top of that
//   same mechanism: monitoring only, no extraction/review/publish triggers.
// RULES:
//   - checksum = SHA-256 hex (Node built-in crypto) of the stored bytes:
//     raw Buffer for PDF, UTF-8 bytes of the string for HTML/OTHER.
//   - PDF content must be a Buffer; HTML/OTHER content must be a string.
//     Anything else is rejected before touching the database.
//   - A unique { url, checksum } index backs the check; duplicate-key races
//     resolve to the existing record instead of throwing.
// =============================================================================

const crypto = require("crypto");

function checksumFor(content) {
  const bytes = Buffer.isBuffer(content)
    ? content
    : Buffer.from(String(content), "utf8");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function normalizeContent(type, content) {
  if (type === "PDF") {
    if (!Buffer.isBuffer(content)) {
      throw new Error("rawDocumentStore: PDF content must be a Buffer");
    }
    return content;
  }
  if (typeof content !== "string") {
    throw new Error(
      `rawDocumentStore: ${type || "unknown"} content must be a string`
    );
  }
  return content;
}

function isDuplicateKeyError(error) {
  return error && (error.code === 11000 || error.code === 11001);
}

// Normalize content coming BACK from storage. Lean reads skip schema getters,
// so BSON Binary (driver form of a stored Buffer) is converted to Buffer here.
// PDF always yields a Buffer; HTML/OTHER always yield a string.
function normalizeReadContent(type, stored) {
  if (type === "PDF") {
    if (Buffer.isBuffer(stored)) return stored;
    if (stored && stored._bsontype === "Binary" && stored.buffer) {
      return Buffer.from(stored.buffer);
    }
    throw new Error(
      "rawDocumentStore: stored PDF content is not binary-readable"
    );
  }
  return typeof stored === "string" ? stored : String(stored);
}

// raw: { label, url, sourceUrl, type, fetchedAt, status, contentType, content }
// Returns { document, created }.
async function saveRawDocument(RawDocument, raw) {
  if (!RawDocument) {
    throw new Error("rawDocumentStore: RawDocument model is required");
  }
  if (!raw || typeof raw.url !== "string" || typeof raw.sourceUrl !== "string") {
    throw new Error("rawDocumentStore: url and sourceUrl are required");
  }
  if (typeof raw.label !== "string") {
    throw new Error("rawDocumentStore: label is required");
  }

  const content = normalizeContent(raw.type, raw.content);
  const checksum = checksumFor(content);

  const existing = await RawDocument.findOne({
    url: raw.url,
    checksum,
  });
  if (existing) return { document: existing, created: false };

  try {
    const created = await RawDocument.create({
      label: raw.label,
      url: raw.url,
      sourceUrl: raw.sourceUrl,
      type: raw.type,
      contentType: raw.contentType || null,
      fetchedAt: raw.fetchedAt,
      status: raw.status === undefined ? null : raw.status,
      checksum,
      content,
    });
    return { document: created, created: true };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const raced = await RawDocument.findOne({ url: raw.url, checksum });
      if (raced) return { document: raced, created: false };
    }
    throw error;
  }
}

// Drift statuses for re-crawl monitoring. Generic checksum comparison only —
// no semantic diffing, no exam knowledge, no downstream triggers.
const DRIFT_STATUSES = ["NEW", "UNCHANGED", "CHANGED"];

// checkDrift(RawDocument, raw) -> drift result. Compares a freshly retrieved
// document against the latest stored version for the same URL, then persists
// through saveRawDocument (the ONLY write path — same validation, same
// dedup, same history preservation):
//   NEW       : no previous document for this URL; the retrieval is stored.
//   UNCHANGED : same checksum; the existing record is returned, nothing new
//               is stored (no duplicate historical content).
//   CHANGED   : different checksum; the previous record is preserved and the
//               new bytes are stored as a new historical version.
// Returns { url, label, status, previousChecksum, currentChecksum,
//   previousFetchedAt, currentFetchedAt, documentId, created }.
// Monitoring only: never triggers extraction, review, adjudication,
// promotion, or publishing.
async function checkDrift(RawDocument, raw) {
  if (!RawDocument) {
    throw new Error("rawDocumentStore: RawDocument model is required");
  }
  if (!raw || typeof raw.url !== "string") {
    throw new Error("rawDocumentStore: raw document url is required");
  }

  const previous = await RawDocument.findOne({ url: raw.url })
    .sort({ fetchedAt: -1, _id: -1 })
    .lean();
  const { document, created } = await saveRawDocument(RawDocument, raw);

  const currentChecksum = document.checksum;
  const currentFetchedAt = new Date(raw.fetchedAt);

  if (!previous) {
    return {
      url: raw.url,
      label: raw.label ?? null,
      status: "NEW",
      previousChecksum: null,
      currentChecksum,
      previousFetchedAt: null,
      currentFetchedAt,
      documentId: String(document._id),
      created,
    };
  }
  if (String(previous._id) === String(document._id)) {
    return {
      url: raw.url,
      label: raw.label ?? null,
      status: "UNCHANGED",
      previousChecksum: previous.checksum,
      currentChecksum,
      previousFetchedAt: previous.fetchedAt,
      currentFetchedAt,
      documentId: String(document._id),
      created,
    };
  }
  return {
    url: raw.url,
    label: raw.label ?? null,
    status: "CHANGED",
    previousChecksum: previous.checksum,
    currentChecksum,
    previousFetchedAt: previous.fetchedAt,
    currentFetchedAt,
    documentId: String(document._id),
    created,
  };
}

module.exports = {
  checksumFor,
  normalizeContent,
  normalizeReadContent,
  saveRawDocument,
  checkDrift,
  DRIFT_STATUSES,
};
