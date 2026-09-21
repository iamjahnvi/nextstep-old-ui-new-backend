// =============================================================================
// scraper/tests/reviewPipeline.test.js
// =============================================================================
// WHAT: Phase 6 tests — persistent DRAFT storage, review, promotion to
//   VERIFIED / rejection, and safeguards against production writes.
// WHY: Proves the safety boundary machine extraction → trusted data lives
//   entirely inside scraper staging: drafts persist, only valid DRAFTs verify,
//   evidence and RawDocuments survive untouched, and no path reaches the
//   production/demo Exam collections.
// DB: isolated mongodb-memory-server only; production MONGO_URI is unset.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");

const {
  EDITION_DRAFT_COLLECTION,
  getExamEditionDraftModel,
} = require("../models/examEditionDraft");
const {
  assertStagingDraftModel,
  reviewDraft,
  saveDraft,
  getDraft,
  listDrafts,
  promoteDraft,
  rejectDraft,
  publishVerifiedDrafts,
} = require("../pipeline/reviewPipeline");
const { runExtractionPipeline } = require("../pipeline/extractionPipeline");
const {
  saveRawDocument,
  normalizeReadContent,
} = require("../persistence/rawDocumentStore");
const { buildUnknownEligibility } = require("../validators/examValidator");
const {
  startIsolatedDb,
  connectRawDocuments,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

const ADAPTER = {
  slug: "phase6-test-exam",
  name: "Phase6 Test Exam",
  fullForm: "Phase Six Test Examination",
  conductingBody: "Phase Six Test Board",
  officialWebsite: "http://127.0.0.1/",
  startUrls: ["http://127.0.0.1/"],
  render: "static",
  docRules: [],
};

function validExam() {
  return {
    slug: "phase6-test-exam",
    name: "Phase6 Test Exam",
    fullForm: "Phase Six Test Examination",
    conductingBody: "Phase Six Test Board",
    officialWebsite: "http://127.0.0.1/",
    careerType: null,
    examType: null,
  };
}

function validEvidence() {
  return {
    sourceUrl: "http://127.0.0.1/",
    documentUrl: "http://127.0.0.1/bulletin.html",
    docType: "HTML",
    retrievedAt: new Date("2026-01-02T00:00:00Z"),
    section: "information-bulletin",
    page: null,
    excerpt: "Registration Start Date: 15 January 2026.",
    confidence: "HIGH",
    extractor: "registrationDates.v1",
  };
}

function validEdition() {
  return {
    examSlug: "phase6-test-exam",
    year: 2026,
    cycle: "2026",
    registration: {
      startDate: new Date("2026-01-15T00:00:00Z"),
      endDate: new Date("2026-02-20T00:00:00Z"),
    },
    eligibility: buildUnknownEligibility(),
    sources: [validEvidence()],
    status: "DRAFT",
  };
}

describe("Phase 6 — reviewPipeline (staging DRAFT → REVIEW → VERIFIED)", () => {
  let mongod;
  let mongoUri;
  let connection;
  let RawDocument;
  let EditionDraft;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("phase6_review"));
    ({ connection, RawDocument } = await connectRawDocuments(mongoUri));
    EditionDraft = getExamEditionDraftModel(connection);
    assert.equal(EDITION_DRAFT_COLLECTION, "scraper_editiondrafts");
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    assert.equal(connection.readyState, 0, "test connection must be closed");
  });

  it("1+2. extracted edition saves as DRAFT and can be retrieved", async () => {
    const exam = validExam();
    const edition = validEdition();
    const saved = await saveDraft(EditionDraft, { exam, edition });
    assert.equal(saved.status, "DRAFT");
    assert.equal(saved.examSlug, "phase6-test-exam");
    assert.equal(saved.decidedAt, null);

    const fetched = await getDraft(EditionDraft, saved._id);
    assert.equal(String(fetched._id), String(saved._id));
    assert.equal(fetched.status, "DRAFT");
    assert.equal(
      new Date(fetched.edition.registration.startDate).toISOString(),
      "2026-01-15T00:00:00.000Z"
    );

    const listed = await listDrafts(EditionDraft, { status: "DRAFT" });
    assert.ok(listed.some((d) => String(d._id) === String(saved._id)));
  });

  it("3+5. valid DRAFT promotes to VERIFIED and retains evidence", async () => {
    const saved = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: validEdition(),
    });
    const before = JSON.parse(JSON.stringify(saved.edition.sources));

    const promoted = await promoteDraft(EditionDraft, saved._id, {
      decidedBy: "reviewer-1",
    });
    assert.equal(promoted.status, "VERIFIED");
    assert.ok(promoted.decidedAt instanceof Date);
    assert.equal(promoted.decidedBy, "reviewer-1");
    assert.deepEqual(
      JSON.parse(JSON.stringify(promoted.edition.sources)),
      before
    );

    const refetched = await getDraft(EditionDraft, saved._id);
    assert.equal(refetched.status, "VERIFIED");
  });

  it("4. invalid DRAFT cannot be promoted", async () => {
    // Inserted around the service (saveDraft would refuse it) to prove the
    // promotion-time re-validation boundary.
    const broken = await EditionDraft.create({
      examSlug: "phase6-test-exam",
      year: 2026,
      cycle: "2026",
      exam: validExam(),
      edition: {
        ...validEdition(),
        registration: {
          startDate: new Date("2026-02-20T00:00:00Z"),
          endDate: new Date("2026-01-15T00:00:00Z"),
        },
      },
      status: "DRAFT",
      rawDocuments: [],
    });
    await assert.rejects(() => promoteDraft(EditionDraft, broken._id), /invalid/i);
    assert.equal((await getDraft(EditionDraft, broken._id)).status, "DRAFT");

    const noEvidence = await EditionDraft.create({
      examSlug: "phase6-test-exam",
      year: 2026,
      cycle: "2026",
      exam: validExam(),
      edition: { ...validEdition(), sources: null },
      status: "DRAFT",
      rawDocuments: [],
    });
    await assert.rejects(
      () => promoteDraft(EditionDraft, noEvidence._id),
      /evidence/i
    );
  });

  it("reviewDraft reports field and evidence issues without changing state", async () => {
    const good = reviewDraft({ exam: validExam(), edition: validEdition() });
    assert.equal(good.valid, true);

    const bad = reviewDraft({
      exam: validExam(),
      edition: { ...validEdition(), examSlug: "" },
    });
    assert.equal(bad.valid, false);
    assert.ok(bad.editionIssues.length > 0);
  });

  it("6. RawDocument remains unchanged after save + promotion", async () => {
    const { document: raw } = await saveRawDocument(RawDocument, {
      label: "information-bulletin",
      url: "http://127.0.0.1/phase6-bulletin.html",
      sourceUrl: "http://127.0.0.1/",
      type: "HTML",
      contentType: "text/html",
      fetchedAt: new Date("2026-01-02T00:00:00Z"),
      status: 200,
      content: "<html><body><p>Registration Start Date: 15 January 2026.</p></body></html>",
    });
    const snapshot = await RawDocument.findById(raw._id).lean();

    const saved = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: validEdition(),
      rawDocuments: [
        {
          documentId: raw._id,
          url: raw.url,
          checksum: raw.checksum,
          label: raw.label,
        },
      ],
    });
    await promoteDraft(EditionDraft, saved._id);

    const after = await RawDocument.findById(raw._id).lean();
    assert.equal(after.checksum, snapshot.checksum);
    assert.equal(
      normalizeReadContent(after.type, after.content),
      normalizeReadContent(snapshot.type, snapshot.content)
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(saved.rawDocuments[0].documentId)),
      JSON.parse(JSON.stringify(raw._id))
    );
  });

  it("7. DRAFT cannot be promoted twice", async () => {
    const saved = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: validEdition(),
    });
    await promoteDraft(EditionDraft, saved._id);
    await assert.rejects(
      () => promoteDraft(EditionDraft, saved._id),
      /only DRAFT/
    );
    assert.equal((await getDraft(EditionDraft, saved._id)).status, "VERIFIED");
  });

  it("8. REJECTED records cannot be promoted", async () => {
    const saved = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: validEdition(),
    });
    const rejected = await rejectDraft(EditionDraft, saved._id, {
      reason: "dates need a second source",
      decidedBy: "reviewer-2",
    });
    assert.equal(rejected.status, "REJECTED");
    assert.equal(rejected.rejectReason, "dates need a second source");
    await assert.rejects(
      () => promoteDraft(EditionDraft, saved._id),
      /only DRAFT/
    );
    await assert.rejects(
      () => rejectDraft(EditionDraft, saved._id),
      /only DRAFT/
    );
  });

  it("end-to-end: Phase 5 extraction → DRAFT → VERIFIED", async () => {
    const result = await runExtractionPipeline(ADAPTER, {
      rawDocuments: [
        {
          label: "information-bulletin",
          url: "http://127.0.0.1/bulletin.html",
          sourceUrl: "http://127.0.0.1/",
          type: "HTML",
          contentType: "text/html",
          fetchedAt: new Date("2026-01-02T00:00:00Z"),
          status: 200,
          content:
            "<html><head><title>Bulletin</title></head><body>" +
            "<p>Registration Start Date: 15 January 2026. Complete the online application process in time.</p>" +
            "<p>The Last date of application is 20 February 2026. Late forms will not be accepted whatsoever.</p>" +
            "</body></html>",
        },
      ],
    });
    const saved = await saveDraft(EditionDraft, {
      exam: result.exam,
      edition: result.edition,
    });
    assert.equal(saved.status, "DRAFT");
    const promoted = await promoteDraft(EditionDraft, saved._id);
    assert.equal(promoted.status, "VERIFIED");
    assert.ok(promoted.edition.sources.length > 0);
  });

  it("9. production/demo exam data is never touched", async () => {
    // Only staging collections exist on the test connection.
    const names = connection.modelNames();
    assert.ok(names.includes("ScraperRawDocument"));
    assert.ok(names.includes("ScraperExamEditionDraft"));
    assert.ok(!names.includes("Exam"));

    for (const name of names) {
      const collection = connection.model(name).collection.name;
      assert.ok(
        collection.startsWith("scraper_"),
        `unexpected collection ${collection}`
      );
    }

    // The guard refuses production-looking models outright.
    assert.throws(
      () => assertStagingDraftModel({ collection: { name: "exams" } }),
      /refusing to operate on collection "exams"/
    );

    // The future publish boundary refuses to run (no production write path).
    await assert.rejects(() => publishVerifiedDrafts(), /not implemented/);

    // Review/promotion sources never reference server storage or schedulers.
    for (const relative of [
      "models/examEditionDraft.js",
      "pipeline/reviewPipeline.js",
    ]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      assert.ok(!/require\(["'][^"']*server\//.test(code));
      assert.ok(!/\brequire\([^)]*\/Exam["']/.test(code));
      assert.ok(!/\brequire\([^)]*seed[^)]*\)/i.test(code));
      assert.ok(!/cron|redis|kafka|apify|openai|anthropic/i.test(code));
    }
  });

  it("10+11. careerType/examType stay null and no month is introduced", async () => {
    const saved = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: validEdition(),
    });
    assert.equal(saved.exam.careerType, null);
    assert.equal(saved.exam.examType, null);
    assert.ok(!("month" in saved.exam));
    assert.ok(!("month" in saved.edition));

    const promoted = await promoteDraft(EditionDraft, saved._id);
    assert.equal(promoted.exam.careerType, null);
    assert.equal(promoted.exam.examType, null);

    // A month field is rejected by the strict schemas at save time.
    await assert.rejects(
      () =>
        saveDraft(EditionDraft, {
          exam: { ...validExam(), month: "January" },
          edition: validEdition(),
        }),
      /invalid/i
    );
  });

  it("12. leaves no temporary/download artifacts in the repo", () => {
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
