// =============================================================================
// scraper/tests/adjudication.test.js
// =============================================================================
// WHAT: Phase 13 tests — operator adjudication of UNKNOWN-with-evidence
//   eligibility axes on DRAFT records (CONFIRM_VALUE / KEEP_UNKNOWN).
// WHY: Proves an operator can resolve extractor ambiguity explicitly, with
//   original evidence preserved and a full audit trail, while VERIFIED /
//   REJECTED records stay immutable and nothing auto-promotes or auto-fills.
// DB: isolated mongodb-memory-server only; production MONGO_URI is unset.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { getExamEditionDraftModel } = require("../models/examEditionDraft");
const {
  saveDraft,
  getDraft,
  promoteDraft,
  rejectDraft,
  adjudicateDraft,
} = require("../pipeline/reviewPipeline");
const { extractEligibility } = require("../extractors/eligibility");
const { buildUnknownEligibility } = require("../validators/examValidator");
const {
  startIsolatedDb,
  connectRawDocuments,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

const CTX = {
  sourceUrl: "http://127.0.0.1/",
  documentUrl: "http://127.0.0.1/bulletin.html",
  docType: "HTML",
  retrievedAt: new Date("2026-01-02T00:00:00Z"),
  section: "information-bulletin",
};

// Authentic multi-category extraction (bachelor's + master's listed): the
// Phase 12 rule yields UNKNOWN with both category excerpts preserved.
const MIXED_TEXT = [
  "Candidates who have completed a Bachelor's degree in Engineering are eligible to apply for the examination.",
  "Candidates holding an M.Sc. or equivalent Master's degree in Science may also apply for the examination.",
  "A minimum of 75% marks in aggregate is required for general category candidates seeking admission this year.",
].join(" ");

function validExam() {
  return {
    slug: "phase13-test-exam",
    name: "Phase13 Test Exam",
    fullForm: "Phase Thirteen Test Examination",
    conductingBody: "Phase Thirteen Test Board",
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

function mixedEdition() {
  const extracted = extractEligibility(MIXED_TEXT, CTX);
  assert.equal(extracted.education.status, "UNKNOWN");
  return {
    examSlug: "phase13-test-exam",
    year: 2026,
    cycle: "2026",
    registration: {
      startDate: new Date("2026-01-15T00:00:00Z"),
      endDate: new Date("2026-02-20T00:00:00Z"),
    },
    eligibility: {
      ...buildUnknownEligibility(),
      education: extracted.education,
      percentage: {
        min: 75,
        status: "KNOWN",
        evidence: validEvidence(),
      },
    },
    sources: [validEvidence(), extracted.education.evidence],
    status: "DRAFT",
  };
}

describe("Phase 13 — adjudicateDraft (operator resolution, stays DRAFT)", () => {
  let mongod;
  let mongoUri;
  let connection;
  let EditionDraft;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("phase13_adjudication"));
    ({ connection } = await connectRawDocuments(mongoUri));
    EditionDraft = getExamEditionDraftModel(connection);
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    assert.equal(connection.readyState, 0, "test connection must be closed");
  });

  async function mixedDraftId() {
    const saved = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: mixedEdition(),
    });
    return saved._id;
  }

  it("1+4+5. CONFIRM_VALUE sets a canonical level, keeps evidence, records audit", async () => {
    const id = await mixedDraftId();
    const before = await getDraft(EditionDraft, id);
    const originalEvidence = JSON.parse(
      JSON.stringify(before.edition.eligibility.education.evidence)
    );

    const updated = await adjudicateDraft(EditionDraft, id, {
      axis: "education",
      decision: "CONFIRM_VALUE",
      value: "Graduate",
      decidedBy: "operator-1",
      note: "UG track confirmed against brochure section 3",
    });

    assert.equal(updated.status, "DRAFT");
    assert.equal(updated.edition.eligibility.education.status, "KNOWN");
    assert.equal(updated.edition.eligibility.education.minLevel, "Graduate");
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(updated.edition.eligibility.education.evidence)
      ),
      originalEvidence
    );

    assert.equal(updated.adjudications.length, 1);
    const record = updated.adjudications[0];
    assert.equal(record.axis, "education");
    assert.equal(record.decision, "CONFIRM_VALUE");
    assert.equal(record.value, "Graduate");
    assert.equal(record.decidedBy, "operator-1");
    assert.ok(record.decidedAt instanceof Date);
    assert.equal(record.note, "UG track confirmed against brochure section 3");

    // No auto-promotion; but the adjudicated draft is promotable as usual.
    assert.equal((await getDraft(EditionDraft, id)).status, "DRAFT");
    const promoted = await promoteDraft(EditionDraft, id);
    assert.equal(promoted.status, "VERIFIED");
  });

  it("2. CONFIRM_VALUE with a non-canonical level is rejected untouched", async () => {
    const id = await mixedDraftId();
    await assert.rejects(
      () =>
        adjudicateDraft(EditionDraft, id, {
          axis: "education",
          decision: "CONFIRM_VALUE",
          value: "Astrophysics",
          decidedBy: "operator-1",
        }),
      /canonical education level/
    );
    const untouched = await getDraft(EditionDraft, id);
    assert.equal(untouched.edition.eligibility.education.status, "UNKNOWN");
    assert.equal(untouched.edition.eligibility.education.minLevel, null);
    assert.deepEqual(untouched.adjudications, []);
  });

  it("3. KEEP_UNKNOWN leaves value null with evidence and audit intact", async () => {
    const id = await mixedDraftId();
    const updated = await adjudicateDraft(EditionDraft, id, {
      axis: "education",
      decision: "KEEP_UNKNOWN",
      decidedBy: "operator-2",
    });
    assert.equal(updated.status, "DRAFT");
    assert.equal(updated.edition.eligibility.education.status, "UNKNOWN");
    assert.equal(updated.edition.eligibility.education.minLevel, null);
    assert.ok(updated.edition.eligibility.education.evidence);
    assert.equal(updated.adjudications.length, 1);
    assert.equal(updated.adjudications[0].decision, "KEEP_UNKNOWN");
    assert.equal(updated.adjudications[0].value, null);
    assert.equal(updated.adjudications[0].decidedBy, "operator-2");

    await assert.rejects(
      () =>
        adjudicateDraft(EditionDraft, id, {
          axis: "education",
          decision: "KEEP_UNKNOWN",
          value: "Graduate",
          decidedBy: "operator-2",
        }),
      /takes no value/
    );
  });

  it("6+7. VERIFIED and REJECTED drafts are immutable", async () => {
    const vId = await mixedDraftId();
    await adjudicateDraft(EditionDraft, vId, {
      axis: "education",
      decision: "CONFIRM_VALUE",
      value: "Graduate",
      decidedBy: "operator-1",
    });
    await promoteDraft(EditionDraft, vId);
    await assert.rejects(
      () =>
        adjudicateDraft(EditionDraft, vId, {
          axis: "education",
          decision: "KEEP_UNKNOWN",
          decidedBy: "operator-1",
        }),
      /only DRAFT/
    );

    const rId = await mixedDraftId();
    await rejectDraft(EditionDraft, rId, { reason: "stale" });
    await assert.rejects(
      () =>
        adjudicateDraft(EditionDraft, rId, {
          axis: "education",
          decision: "KEEP_UNKNOWN",
          decidedBy: "operator-1",
        }),
      /only DRAFT/
    );
  });

  it("8. unrelated fields are never modified", async () => {
    const id = await mixedDraftId();
    const before = JSON.parse(
      JSON.stringify((await getDraft(EditionDraft, id)).toObject())
    );
    const updated = await adjudicateDraft(EditionDraft, id, {
      axis: "education",
      decision: "CONFIRM_VALUE",
      value: "12",
      decidedBy: "operator-3",
    });
    const after = JSON.parse(JSON.stringify(updated.toObject()));

    assert.deepEqual(after.exam, before.exam);
    assert.deepEqual(
      after.edition.eligibility.percentage,
      before.edition.eligibility.percentage
    );
    assert.deepEqual(after.edition.registration, before.edition.registration);
    assert.deepEqual(after.edition.sources, before.edition.sources);
    assert.deepEqual(after.rawDocuments, before.rawDocuments);
    assert.equal(after.edition.eligibility.education.minLevel, "12");
  });

  it("rejects non-UNKNOWN axes, unknown axes, and missing operators", async () => {
    const id = await mixedDraftId();
    // Non-eligibility axis (careerType) is not adjudicable at all.
    await assert.rejects(
      () =>
        adjudicateDraft(EditionDraft, id, {
          axis: "careerType",
          decision: "KEEP_UNKNOWN",
          decidedBy: "operator-1",
        }),
      /not adjudicable/
    );
    // An already-KNOWN education axis cannot be re-adjudicated either.
    const known = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: {
        ...mixedEdition(),
        eligibility: {
          ...buildUnknownEligibility(),
          education: {
            minLevel: "12",
            maxLevel: null,
            appearingAllowed: null,
            status: "KNOWN",
            evidence: validEvidence(),
          },
        },
      },
    });
    await assert.rejects(
      () =>
        adjudicateDraft(EditionDraft, known._id, {
          axis: "education",
          decision: "KEEP_UNKNOWN",
          decidedBy: "operator-1",
        }),
      /not UNKNOWN/
    );
    await assert.rejects(
      () =>
        adjudicateDraft(EditionDraft, id, {
          axis: "education",
          decision: "MAYBE",
          decidedBy: "operator-1",
        }),
      /CONFIRM_VALUE \| KEEP_UNKNOWN/
    );
    await assert.rejects(
      () =>
        adjudicateDraft(EditionDraft, id, {
          axis: "education",
          decision: "KEEP_UNKNOWN",
          decidedBy: "  ",
        }),
      /decidedBy.*required/
    );
    assert.deepEqual((await getDraft(EditionDraft, id)).adjudications, []);
  });

  it("touches no production/demo storage or schedulers", () => {
    for (const relative of [
      "models/examEditionDraft.js",
      "pipeline/reviewPipeline.js",
    ]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      assert.ok(!/require\(["'][^"']*server\//.test(code), `${relative}: no server imports`);
      assert.ok(!/cron|redis|kafka|apify|openai|anthropic/i.test(code));
    }
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
