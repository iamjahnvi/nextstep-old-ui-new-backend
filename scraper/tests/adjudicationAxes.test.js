// =============================================================================
// scraper/tests/adjudicationAxes.test.js
// =============================================================================
// WHAT: Phase 24 tests — adjudication contracts for percentage, age, stream,
//   and subjects alongside the unchanged education contract.
// WHY: Proves an operator can resolve any eligibility UNKNOWN with a
//   canonical value (or keep it UNKNOWN) while evidence, audit trail,
//   revalidation, and DRAFT-only rules hold for every axis.
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
  reviewDraft,
  promoteDraft,
  rejectDraft,
  adjudicateDraft,
  normalizeAdjudicatedEducationLevel,
  normalizeAdjudicatedPercentage,
  normalizeAdjudicatedAge,
  normalizeAdjudicatedStringList,
  ADJUDICABLE_AXES,
} = require("../pipeline/reviewPipeline");
const { buildUnknownEligibility } = require("../validators/examValidator");
const {
  startIsolatedDb,
  connectRawDocuments,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

function validExam() {
  return {
    slug: "phase24-test-exam",
    name: "Phase24 Test Exam",
    fullForm: "Phase Twenty-Four Test Examination",
    conductingBody: "Phase Twenty-Four Test Board",
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
    excerpt: "Eligibility as per the official bulletin.",
    confidence: "MEDIUM",
    extractor: "eligibility.v1",
  };
}

function unknownEdition() {
  const eligibility = buildUnknownEligibility();
  for (const axis of Object.values(eligibility)) {
    axis.evidence = validEvidence();
  }
  return {
    examSlug: "phase24-test-exam",
    year: 2026,
    cycle: "2026",
    registration: {
      startDate: new Date("2026-01-15T00:00:00Z"),
      endDate: new Date("2026-02-20T00:00:00Z"),
    },
    eligibility,
    sources: [validEvidence()],
    status: "DRAFT",
  };
}

describe("Phase 24 — adjudication contracts for all eligibility axes", () => {
  let mongod;
  let mongoUri;
  let connection;
  let EditionDraft;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("phase24_axes"));
    ({ connection } = await connectRawDocuments(mongoUri));
    EditionDraft = getExamEditionDraftModel(connection);
    assert.deepEqual([...ADJUDICABLE_AXES].sort(), [
      "age",
      "education",
      "percentage",
      "stream",
      "subjects",
    ]);
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    assert.equal(connection.readyState, 0, "test connection must be closed");
  });

  async function unknownDraftId() {
    const saved = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: unknownEdition(),
    });
    return saved._id;
  }

  async function axisOf(id, axis) {
    const draft = await getDraft(EditionDraft, id);
    return JSON.parse(JSON.stringify(draft.edition.eligibility[axis]));
  }

  it("1+2. education contracts behave exactly as before", async () => {
    const confirmedId = await unknownDraftId();
    const confirmed = await adjudicateDraft(EditionDraft, confirmedId, {
      axis: "education",
      decision: "CONFIRM_VALUE",
      value: "Graduate",
      decidedBy: "operator-1",
    });
    assert.equal(confirmed.edition.eligibility.education.status, "KNOWN");
    assert.equal(confirmed.edition.eligibility.education.minLevel, "Graduate");

    const keptId = await unknownDraftId();
    const kept = await adjudicateDraft(EditionDraft, keptId, {
      axis: "education",
      decision: "KEEP_UNKNOWN",
      decidedBy: "operator-1",
    });
    assert.equal(kept.edition.eligibility.education.status, "UNKNOWN");
    assert.equal(kept.edition.eligibility.education.minLevel, null);
  });

  it("3+4. percentage CONFIRM accepts canonical values, rejects the rest", async () => {
    const id = await unknownDraftId();
    const updated = await adjudicateDraft(EditionDraft, id, {
      axis: "percentage",
      decision: "CONFIRM_VALUE",
      value: 75,
      decidedBy: "operator-1",
      note: "bulletin page 4",
    });
    assert.equal(updated.edition.eligibility.percentage.status, "KNOWN");
    assert.equal(updated.edition.eligibility.percentage.min, 75);
    assert.equal(updated.adjudications[0].value, 75);

    const strId = await unknownDraftId();
    const strUpdated = await adjudicateDraft(EditionDraft, strId, {
      axis: "percentage",
      decision: "CONFIRM_VALUE",
      value: "75%",
      decidedBy: "operator-1",
    });
    assert.equal(strUpdated.edition.eligibility.percentage.min, 75);

    for (const bad of [150, -5, "abc", NaN, {}, [], true, ""]) {
      const badId = await unknownDraftId();
      await assert.rejects(
        () =>
          adjudicateDraft(EditionDraft, badId, {
            axis: "percentage",
            decision: "CONFIRM_VALUE",
            value: bad,
            decidedBy: "operator-1",
          }),
        /canonical|percentage/i,
        `value ${JSON.stringify(bad)} must be rejected`
      );
      const untouched = await getDraft(EditionDraft, badId);
      assert.equal(untouched.edition.eligibility.percentage.status, "UNKNOWN");
      assert.deepEqual(untouched.adjudications, []);
    }
  });

  it("5+6. age CONFIRM accepts min/max pairs, rejects malformed values", async () => {
    const id = await unknownDraftId();
    const updated = await adjudicateDraft(EditionDraft, id, {
      axis: "age",
      decision: "CONFIRM_VALUE",
      value: { min: 17, max: 25 },
      decidedBy: "operator-1",
    });
    assert.equal(updated.edition.eligibility.age.status, "KNOWN");
    assert.equal(updated.edition.eligibility.age.min, 17);
    assert.equal(updated.edition.eligibility.age.max, 25);
    assert.deepEqual(updated.adjudications[0].value, { min: 17, max: 25 });

    const minOnlyId = await unknownDraftId();
    const minOnly = await adjudicateDraft(EditionDraft, minOnlyId, {
      axis: "age",
      decision: "CONFIRM_VALUE",
      value: { min: "21" },
      decidedBy: "operator-1",
    });
    assert.equal(minOnly.edition.eligibility.age.min, 21);
    assert.equal(minOnly.edition.eligibility.age.max, null);

    for (const bad of [
      { min: -1 },
      { min: 17.5 },
      { minimum: 17 },
      {},
      [],
      "17",
      { min: null },
      { min: "seventeen" },
    ]) {
      const badId = await unknownDraftId();
      await assert.rejects(
        () =>
          adjudicateDraft(EditionDraft, badId, {
            axis: "age",
            decision: "CONFIRM_VALUE",
            value: bad,
            decidedBy: "operator-1",
          }),
        /non-negative integer|min.*max/i,
        `value ${JSON.stringify(bad)} must be rejected`
      );
    }
  });

  it("7+8. stream and subject CONFIRM accept string lists", async () => {
    const streamId = await unknownDraftId();
    const streamUpdated = await adjudicateDraft(EditionDraft, streamId, {
      axis: "stream",
      decision: "CONFIRM_VALUE",
      value: ["Science", "Commerce"],
      decidedBy: "operator-1",
    });
    assert.equal(streamUpdated.edition.eligibility.stream.status, "KNOWN");
    assert.deepEqual(streamUpdated.edition.eligibility.stream.allowed, [
      "Science",
      "Commerce",
    ]);

    const singleId = await unknownDraftId();
    const singleUpdated = await adjudicateDraft(EditionDraft, singleId, {
      axis: "subjects",
      decision: "CONFIRM_VALUE",
      value: "Physics",
      decidedBy: "operator-1",
    });
    assert.deepEqual(
      singleUpdated.edition.eligibility.subjects.requiredAny,
      ["Physics"]
    );

    for (const bad of [[], [""], ["  "], [42], "", 42, {}]) {
      const badId = await unknownDraftId();
      await assert.rejects(
        () =>
          adjudicateDraft(EditionDraft, badId, {
            axis: "subjects",
            decision: "CONFIRM_VALUE",
            value: bad,
            decidedBy: "operator-1",
          }),
        /non-empty string/i,
        `value ${JSON.stringify(bad)} must be rejected`
      );
    }
  });

  it("9. KEEP_UNKNOWN works for every newly supported axis", async () => {
    for (const axis of ["percentage", "age", "stream", "subjects"]) {
      const id = await unknownDraftId();
      const updated = await adjudicateDraft(EditionDraft, id, {
        axis,
        decision: "KEEP_UNKNOWN",
        decidedBy: "operator-2",
        note: `needs source recheck`,
      });
      const state = await axisOf(id, axis);
      assert.equal(state.status, "UNKNOWN", axis);
      assert.equal(updated.adjudications[0].decision, "KEEP_UNKNOWN");
      assert.equal(updated.adjudications[0].value, null);
      assert.equal(updated.status, "DRAFT");
    }
  });

  it("10+11. missing decidedBy and invalid axes are rejected", async () => {
    const id = await unknownDraftId();
    await assert.rejects(
      () =>
        adjudicateDraft(EditionDraft, id, {
          axis: "percentage",
          decision: "KEEP_UNKNOWN",
          decidedBy: "  ",
        }),
      /decidedBy/
    );
    for (const axis of ["careerType", "fees", "registration", ""]) {
      await assert.rejects(
        () =>
          adjudicateDraft(EditionDraft, id, {
            axis,
            decision: "KEEP_UNKNOWN",
            decidedBy: "operator-1",
          }),
        /not adjudicable/
      );
    }
    assert.deepEqual((await getDraft(EditionDraft, id)).adjudications, []);
  });

  it("12+14+15. DRAFT-only, revalidated, never auto-verified or published", async () => {
    const id = await unknownDraftId();
    const updated = await adjudicateDraft(EditionDraft, id, {
      axis: "percentage",
      decision: "CONFIRM_VALUE",
      value: 60,
      decidedBy: "operator-1",
    });
    assert.equal(updated.status, "DRAFT");
    assert.equal(reviewDraft(updated).valid, true);
    const promoted = await promoteDraft(EditionDraft, id);
    assert.equal(promoted.status, "VERIFIED");

    await assert.rejects(
      () =>
        adjudicateDraft(EditionDraft, id, {
          axis: "age",
          decision: "KEEP_UNKNOWN",
          decidedBy: "operator-1",
        }),
      /only DRAFT/
    );

    const rejectedId = await unknownDraftId();
    await rejectDraft(EditionDraft, rejectedId, { reason: "stale" });
    await assert.rejects(
      () =>
        adjudicateDraft(EditionDraft, rejectedId, {
          axis: "stream",
          decision: "KEEP_UNKNOWN",
          decidedBy: "operator-1",
        }),
      /only DRAFT/
    );
    assert.deepEqual(connection.modelNames().sort(), [
      "ScraperExamEditionDraft",
      "ScraperRawDocument",
    ]);
  });

  it("13. evidence stays byte-identical after adjudication", async () => {
    const id = await unknownDraftId();
    const before = await getDraft(EditionDraft, id);
    const original = JSON.parse(
      JSON.stringify(before.edition.eligibility.subjects.evidence)
    );
    const updated = await adjudicateDraft(EditionDraft, id, {
      axis: "subjects",
      decision: "CONFIRM_VALUE",
      value: ["Biology"],
      decidedBy: "operator-1",
    });
    assert.deepEqual(
      JSON.parse(JSON.stringify(updated.edition.eligibility.subjects.evidence)),
      original
    );
  });

  it("16. no exam-specific literals in adjudication code", () => {
    const code = fs.readFileSync(
      path.join(__dirname, "..", "pipeline", "reviewPipeline.js"),
      "utf8"
    );
    const executable = code.replace(/\/\/.*$/gm, "");
    assert.ok(
      !/jee-main|gate-2026|\bnta\b|\biit\b|upsc|\bneet\b/i.test(executable)
    );
  });

  it("normalizers behave unit-clean on edge input", () => {
    assert.equal(normalizeAdjudicatedPercentage(" 75 % "), 75);
    assert.equal(normalizeAdjudicatedPercentage(100), 100);
    assert.equal(normalizeAdjudicatedPercentage("abc"), null);
    assert.deepEqual(normalizeAdjudicatedAge({ max: 30 }), {
      min: null,
      max: 30,
    });
    assert.equal(normalizeAdjudicatedAge(null), null);
    assert.deepEqual(normalizeAdjudicatedStringList(["a", "a", "b"]), ["a", "b"]);
    assert.equal(normalizeAdjudicatedStringList([]), null);
    assert.equal(normalizeAdjudicatedEducationLevel("Class XII"), "12");
    assert.equal(normalizeAdjudicatedEducationLevel("class xi"), "11");
    assert.equal(normalizeAdjudicatedEducationLevel("Class X"), "10");
    assert.equal(normalizeAdjudicatedEducationLevel("Senior Secondary"), "12");
    assert.equal(normalizeAdjudicatedEducationLevel("Class 12"), "12");
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
