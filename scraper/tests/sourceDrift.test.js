// =============================================================================
// scraper/tests/sourceDrift.test.js
// =============================================================================
// WHAT: Phase 21 tests — re-crawl drift monitoring (NEW | UNCHANGED |
//   CHANGED) built on the existing checksum + history-preserving store.
// WHY: Locks monitoring-only semantics: first sighting stores, identical
//   bytes never duplicate, changed bytes append history, and nothing here
//   triggers extraction, review, adjudication, promotion, or publishing.
// DB: isolated mongodb-memory-server only; production MONGO_URI is unset.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  checksumFor,
  saveRawDocument,
  checkDrift,
  DRIFT_STATUSES,
} = require("../persistence/rawDocumentStore");
const {
  startIsolatedDb,
  connectRawDocuments,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

const T0 = new Date("2026-01-01T00:00:00Z");
const T1 = new Date("2026-01-02T00:00:00Z");
const T2 = new Date("2026-01-03T00:00:00Z");

function htmlDoc(url, content, fetchedAt, label = "doc") {
  return {
    label,
    url,
    sourceUrl: "http://127.0.0.1/",
    type: "HTML",
    contentType: "text/html",
    fetchedAt,
    status: 200,
    content,
  };
}

describe("Phase 21 — source drift monitoring (checksum-only, no triggers)", () => {
  let mongod;
  let mongoUri;
  let connection;
  let RawDocument;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("phase21_drift"));
    ({ connection, RawDocument } = await connectRawDocuments(mongoUri));
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    assert.equal(connection.readyState, 0, "test connection must be closed");
  });

  it("1. first retrieval produces NEW and persists", async () => {
    const url = "http://127.0.0.1/new-page.html";
    const result = await checkDrift(
      RawDocument,
      htmlDoc(url, "<p>version one</p>", T0)
    );
    assert.equal(result.status, "NEW");
    assert.equal(result.url, url);
    assert.equal(result.previousChecksum, null);
    assert.equal(result.previousFetchedAt, null);
    assert.equal(result.currentChecksum, checksumFor("<p>version one</p>"));
    assert.deepEqual(result.currentFetchedAt, T0);
    assert.equal(result.created, true);
    assert.ok(result.documentId);
    assert.deepEqual([...DRIFT_STATUSES].sort(), ["CHANGED", "NEW", "UNCHANGED"]);
  });

  it("2+7. same URL + same content produces UNCHANGED without duplicates", async () => {
    const url = "http://127.0.0.1/stable-page.html";
    const first = await checkDrift(RawDocument, htmlDoc(url, "<p>stable</p>", T0));
    assert.equal(first.status, "NEW");
    const second = await checkDrift(RawDocument, htmlDoc(url, "<p>stable</p>", T1));
    assert.equal(second.status, "UNCHANGED");
    assert.equal(second.previousChecksum, second.currentChecksum);
    assert.equal(second.created, false);
    assert.equal(second.documentId, first.documentId);
    assert.deepEqual(second.previousFetchedAt, T0);
    assert.deepEqual(second.currentFetchedAt, T1);
    assert.equal(await RawDocument.countDocuments({ url }), 1);
  });

  it("3+4. same URL + changed content produces CHANGED and keeps history", async () => {
    const url = "http://127.0.0.1/changing-page.html";
    const first = await checkDrift(RawDocument, htmlDoc(url, "<p>v1</p>", T0));
    const second = await checkDrift(RawDocument, htmlDoc(url, "<p>v2</p>", T1));
    assert.equal(second.status, "CHANGED");
    assert.notEqual(second.previousChecksum, second.currentChecksum);
    assert.equal(second.previousChecksum, first.currentChecksum);
    assert.equal(second.created, true);
    assert.notEqual(second.documentId, first.documentId);
    assert.deepEqual(second.previousFetchedAt, T0);

    // Previous version preserved byte-identical alongside the new one.
    assert.equal(await RawDocument.countDocuments({ url }), 2);
    const oldDoc = await RawDocument.findById(first.documentId).lean();
    assert.equal(oldDoc.checksum, first.currentChecksum);
    assert.equal(oldDoc.content, "<p>v1</p>");
    const newDoc = await RawDocument.findById(second.documentId).lean();
    assert.equal(newDoc.content, "<p>v2</p>");

    // A third identical retrieval resolves against the newest version.
    const third = await checkDrift(RawDocument, htmlDoc(url, "<p>v2</p>", T2));
    assert.equal(third.status, "UNCHANGED");
    assert.equal(third.documentId, second.documentId);
    assert.equal(await RawDocument.countDocuments({ url }), 2);
  });

  it("5. checksums are deterministic", () => {
    assert.equal(checksumFor("abc"), checksumFor("abc"));
    assert.notEqual(checksumFor("abc"), checksumFor("abd"));
    assert.match(checksumFor("abc"), /^[0-9a-f]{64}$/);
  });

  it("6. documents from the same source track independently", async () => {
    const urlA = "http://127.0.0.1/multi-a.html";
    const urlB = "http://127.0.0.1/multi-b.html";
    await checkDrift(RawDocument, htmlDoc(urlA, "<p>A1</p>", T0, "a"));
    await checkDrift(RawDocument, htmlDoc(urlB, "<p>B1</p>", T0, "b"));
    const changedA = await checkDrift(RawDocument, htmlDoc(urlA, "<p>A2</p>", T1, "a"));
    assert.equal(changedA.status, "CHANGED");
    const sameB = await checkDrift(RawDocument, htmlDoc(urlB, "<p>B1</p>", T1, "b"));
    assert.equal(sameB.status, "UNCHANGED");
    assert.equal(sameB.previousChecksum, sameB.currentChecksum);
  });

  it("8+9. no Exam/ExamEdition, review, or publish side effects", async () => {
    await checkDrift(
      RawDocument,
      htmlDoc("http://127.0.0.1/clean-page.html", "<p>clean</p>", T0)
    );
    assert.deepEqual(connection.modelNames(), ["ScraperRawDocument"]);
    const collections = await connection.db.listCollections().toArray();
    const names = collections.map((c) => c.name).filter((n) => !n.startsWith("system."));
    assert.deepEqual(names, ["scraper_rawdocuments"]);

    const code = fs.readFileSync(
      path.join(__dirname, "..", "persistence", "rawDocumentStore.js"),
      "utf8"
    );
    const executable = code.replace(/\/\/.*$/gm, "");
    assert.ok(!/require\(["'][^"']*server\//.test(code));
    assert.ok(
      !/publish|promot|adjudicat|rejectDraft|ExamEdition|extractEligib/i.test(
        executable
      )
    );
  });

  it("10. no exam-specific literals in drift code", () => {
    const code = fs.readFileSync(
      path.join(__dirname, "..", "persistence", "rawDocumentStore.js"),
      "utf8"
    );
    const executable = code.replace(/\/\/.*$/gm, "");
    assert.ok(!/jee-main|gate-2026|\bnta\b|\biitg?\b/i.test(executable));
  });

  it("11. underlying save semantics used by drift remain intact", async () => {
    const url = "http://127.0.0.1/roundtrip-page.html";
    const { document, created } = await saveRawDocument(
      RawDocument,
      htmlDoc(url, "<p>rt</p>", T0)
    );
    assert.equal(created, true);
    const repeat = await saveRawDocument(RawDocument, htmlDoc(url, "<p>rt</p>", T1));
    assert.equal(repeat.created, false);
    assert.equal(String(repeat.document._id), String(document._id));
  });

  it("leaves no temporary/download artifacts in the repo", () => {
    const repoRoot = path.join(__dirname, "..");
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          entry.name.endsWith(".tmp") ||
          /^(download|temp).*\.pdf$/i.test(entry.name)
        ) {
          offenders.push(full);
        }
      }
    };
    walk(repoRoot);
    assert.deepEqual(offenders, []);
  });
});
