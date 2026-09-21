// =============================================================================
// scraper/tests/rawDocumentStore.test.js
// =============================================================================
// WHAT: Phase 4 staging persistence tests — HTML/PDF persistence, binary
//   integrity, checksum behavior, duplicate handling, validation, cleanup.
// WHY: Proves the staging layer stores exact bytes with SHA-256 identity
//   (url, checksum) without touching demo/production Exam data.
// DB: isolated mongodb-memory-server only; production MONGO_URI is unset for
//   the duration of these tests and restored afterwards.
// RUN: npm test (node --test tests/)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  checksumFor,
  normalizeReadContent,
  saveRawDocument,
} = require("../persistence/rawDocumentStore");
const {
  startIsolatedDb,
  connectRawDocuments,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

const FIXTURE_PDF = path.join(__dirname, "fixtures", "sample.pdf");

describe("Phase 4 — rawDocumentStore staging persistence", () => {
  let mongod;
  let mongoUri;
  let connection;
  let RawDocument;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("phase4_store"));
    ({ connection, RawDocument } = await connectRawDocuments(mongoUri));
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    // Test MongoDB connection is closed after tests.
    assert.equal(connection.readyState, 0, "test connection must be closed");
  });

  it("1. HTML persistence — stores and retrieves string content unchanged", async () => {
    const html = "<html><head><title>Phase 4</title></head><body><p>Hello staging</p></body></html>";
    const { document, created } = await saveRawDocument(RawDocument, {
      label: "landing-page",
      url: "http://127.0.0.1/html-doc",
      sourceUrl: "http://127.0.0.1/",
      type: "HTML",
      contentType: "text/html",
      fetchedAt: new Date(),
      status: 200,
      content: html,
    });
    assert.equal(created, true);

    const hydrated = await RawDocument.findById(document._id);
    assert.equal(typeof hydrated.content, "string");
    assert.equal(hydrated.content, html);

    const lean = await RawDocument.findById(document._id).lean();
    assert.equal(typeof lean.content, "string");
    assert.equal(lean.content, html);
  });

  it("2. PDF persistence — stored binary comes back as Buffer", async () => {
    const original = fs.readFileSync(FIXTURE_PDF);
    assert.ok(Buffer.isBuffer(original));

    const { document } = await saveRawDocument(RawDocument, {
      label: "sample-pdf",
      url: "http://127.0.0.1/sample.pdf",
      sourceUrl: "http://127.0.0.1/",
      type: "PDF",
      contentType: "application/pdf",
      fetchedAt: new Date(),
      status: 200,
      content: original,
    });

    // Lean reads skip schema getters: driver form is BSON Binary.
    const lean = await RawDocument.findById(document._id).lean();
    assert.equal(lean.type, "PDF");
    assert.ok(
      Buffer.isBuffer(lean.content) || lean.content?._bsontype === "Binary",
      "lean PDF content must be binary/BSON Binary"
    );

    const asBuffer = normalizeReadContent(lean.type, lean.content);
    assert.ok(Buffer.isBuffer(asBuffer));

    // Hydrated reads convert BSON Binary back to Buffer via schema getter.
    const hydrated = await RawDocument.findById(document._id);
    assert.ok(Buffer.isBuffer(hydrated.content));
  });

  it("3. PDF binary integrity — bytes identical, checksum matches", async () => {
    const original = fs.readFileSync(FIXTURE_PDF);
    const expected = crypto.createHash("sha256").update(original).digest("hex");

    const { document } = await saveRawDocument(RawDocument, {
      label: "integrity-pdf",
      url: "http://127.0.0.1/integrity.pdf",
      sourceUrl: "http://127.0.0.1/",
      type: "PDF",
      contentType: "application/pdf",
      fetchedAt: new Date(),
      status: 200,
      content: original,
    });

    assert.equal(document.checksum, expected);
    const lean = await RawDocument.findById(document._id).lean();
    const roundTripped = normalizeReadContent(lean.type, lean.content);
    assert.ok(roundTripped.equals(original), "retrieved bytes must be identical");
    assert.equal(checksumFor(roundTripped), expected);
  });

  it("4. checksum behavior — known vector, UTF-8 HTML bytes, raw PDF bytes", async () => {
    // Known SHA-256 vector.
    assert.equal(
      checksumFor("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    // HTML uses UTF-8 bytes of the string.
    const unicode = "héllo — staging ✓";
    assert.equal(
      checksumFor(unicode),
      crypto.createHash("sha256").update(Buffer.from(unicode, "utf8")).digest("hex")
    );
    // PDF uses raw Buffer bytes (non-UTF8 bytes must survive intact).
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    assert.equal(
      checksumFor(raw),
      crypto.createHash("sha256").update(raw).digest("hex")
    );
    assert.notEqual(
      checksumFor(raw),
      checksumFor(raw.toString("utf8")),
      "raw bytes must not be checksummed via lossy string conversion"
    );
  });

  it("5. duplicate handling — same bytes reuse, changed bytes append, history kept", async () => {
    const url = "http://127.0.0.1/dedup-page";
    const first = await saveRawDocument(RawDocument, {
      label: "dedup",
      url,
      sourceUrl: "http://127.0.0.1/",
      type: "HTML",
      contentType: "text/html",
      fetchedAt: new Date(),
      status: 200,
      content: "<p>version one</p>",
    });
    assert.equal(first.created, true);

    const repeat = await saveRawDocument(RawDocument, {
      label: "dedup",
      url,
      sourceUrl: "http://127.0.0.1/",
      type: "HTML",
      contentType: "text/html",
      fetchedAt: new Date(),
      status: 200,
      content: "<p>version one</p>",
    });
    assert.equal(repeat.created, false);
    assert.equal(String(repeat.document._id), String(first.document._id));
    assert.equal(await RawDocument.countDocuments({ url }), 1);

    const changed = await saveRawDocument(RawDocument, {
      label: "dedup",
      url,
      sourceUrl: "http://127.0.0.1/",
      type: "HTML",
      contentType: "text/html",
      fetchedAt: new Date(),
      status: 200,
      content: "<p>version two</p>",
    });
    assert.equal(changed.created, true);
    assert.notEqual(String(changed.document._id), String(first.document._id));
    assert.equal(await RawDocument.countDocuments({ url }), 2);

    // History is NOT overwritten or deleted: original bytes still intact.
    const original = await RawDocument.findById(first.document._id).lean();
    assert.equal(original.content, "<p>version one</p>");
  });

  it("rejects wrong content kinds before touching storage rules", async () => {
    await assert.rejects(
      () =>
        saveRawDocument(RawDocument, {
          label: "bad-pdf",
          url: "http://127.0.0.1/bad.pdf",
          sourceUrl: "http://127.0.0.1/",
          type: "PDF",
          fetchedAt: new Date(),
          status: 200,
          content: "<p>not a buffer</p>",
        }),
      /PDF content must be a Buffer/
    );
    await assert.rejects(
      () =>
        saveRawDocument(RawDocument, {
          label: "bad-html",
          url: "http://127.0.0.1/bad.html",
          sourceUrl: "http://127.0.0.1/",
          type: "HTML",
          fetchedAt: new Date(),
          status: 200,
          content: Buffer.from("not a string"),
        }),
      /content must be a string/
    );
  });

  it("7. cleanup — no temporary/download artifacts left in the repo", async () => {
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
    assert.deepEqual(offenders, [], "scraper artifacts must not remain");
  });
});
