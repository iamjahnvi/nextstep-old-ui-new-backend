// =============================================================================
// scraper/tests/extractionPipeline.test.js
// =============================================================================
// WHAT: Phase 5 end-to-end tests — staged RawDocuments become a validated
//   ExamEdition DRAFT via the real parser/extractor/normalizer/validator chain.
// WHY: Proves the flow RawDocument → text prep → extractors → normalization →
//   validation → DRAFT without touching demo/production Exam data.
// DB: in-memory RawDocuments passed directly, plus one isolated
//   mongodb-memory-server round-trip; production MONGO_URI is unset.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");

const { runExtractionPipeline } = require("../pipeline/extractionPipeline");
const { saveRawDocument } = require("../persistence/rawDocumentStore");
const {
  validateExam,
  validateExamEdition,
  validateEvidence,
} = require("../validators/examValidator");
const {
  startIsolatedDb,
  connectRawDocuments,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

const ADAPTER = {
  slug: "phase5-test-exam",
  name: "Phase5 Test Exam",
  fullForm: "Phase Five Test Examination",
  conductingBody: "Phase Five Test Board",
  officialWebsite: "http://127.0.0.1/",
  startUrls: ["http://127.0.0.1/"],
  render: "static",
  docRules: [],
  subjectVocabulary: [
    { canonical: "Physics", match: ["physics"] },
    { canonical: "Chemistry", match: ["chemistry"] },
    { canonical: "Mathematics", match: ["mathematics", "maths", "math"] },
    { canonical: "Biology", match: ["biology"] },
    { canonical: "Computer Science", match: ["computer science"] },
  ],
  streamVocabulary: [{ canonical: "Science", match: ["science stream"] }],
};

const BULLETIN_HTML = [
  "<html><head><title>Information Bulletin</title></head><body>",
  "<h1>Information Bulletin 2026</h1>",
  "<p>Registration Start Date: 15 January 2026. Candidates must complete the online application process before the deadline.</p>",
  "<p>The Last date of application is 20 February 2026. Late forms will not be accepted under any circumstances whatsoever.</p>",
  "<p>Candidates must have passed 10+2 with Physics, Chemistry and Mathematics from a recognized board examination.</p>",
  "<p>A minimum of 75% marks in aggregate is required for general category candidates seeking admission this year.</p>",
  "<p>Minimum age is 17 years. Applicants must be from the Science stream to be considered eligible for counselling.</p>",
  "</body></html>",
].join("");

function stagedDoc(overrides = {}) {
  return {
    label: "information-bulletin",
    url: "http://127.0.0.1/bulletin.html",
    sourceUrl: "http://127.0.0.1/",
    type: "HTML",
    contentType: "text/html",
    fetchedAt: new Date("2026-01-02T00:00:00Z"),
    status: 200,
    content: BULLETIN_HTML,
    ...overrides,
  };
}

describe("Phase 5 — runExtractionPipeline", () => {
  let savedMongoUri;

  before(() => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
  });

  after(() => {
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0, "pipeline must not leak connections");
  });

  it("builds a validated ExamEdition DRAFT from staged HTML", async () => {
    const result = await runExtractionPipeline(ADAPTER, {
      rawDocuments: [stagedDoc()],
    });

    assert.equal(result.adapter, "phase5-test-exam");
    assert.equal(result.year, 2026);
    assert.equal(result.cycle, "2026");
    assert.equal(result.validation.examOk, true);
    assert.equal(result.validation.editionOk, true);

    assert.equal(
      result.edition.registration.startDate.toISOString(),
      "2026-01-15T00:00:00.000Z"
    );
    assert.equal(
      result.edition.registration.endDate.toISOString(),
      "2026-02-20T00:00:00.000Z"
    );

    assert.equal(result.edition.eligibility.education.minLevel, "12");
    assert.equal(result.edition.eligibility.percentage.min, 75);
    assert.equal(result.edition.eligibility.age.min, 17);
    assert.deepEqual(result.edition.eligibility.stream.allowed, ["Science"]);

    assert.equal(result.edition.status, "DRAFT");
    assert.equal(result.exam.careerType, null);
    assert.equal(result.exam.examType, null);
    assert.ok(!("month" in result.edition));
    assert.ok(!("month" in result.exam));

    assert.ok(result.edition.sources.length > 0);
    for (const source of result.edition.sources) {
      assert.ok(validateEvidence(source).success);
    }
    assert.ok(validateExam(result.exam).success);
    assert.ok(validateExamEdition(result.edition).success);
  });

  it("returns an honest all-UNKNOWN draft for empty content", async () => {
    const result = await runExtractionPipeline(ADAPTER, {
      rawDocuments: [stagedDoc({ url: "http://127.0.0.1/empty.html", content: "<html></html>" })],
      year: 2027,
    });
    assert.equal(result.edition.registration.startDate, null);
    assert.equal(result.edition.registration.endDate, null);
    for (const axis of Object.values(result.edition.eligibility)) {
      assert.equal(axis.status, "UNKNOWN");
    }
    assert.deepEqual(result.edition.sources, []);
    assert.ok(validateExamEdition(result.edition).success);
  });

  it("keeps multi-category education UNKNOWN with evidence in a valid draft", async () => {
    const html = [
      "<html><head><title>Multi-track Bulletin</title></head><body>",
      "<p>Registration Start Date: 15 January 2026. Candidates must complete the online application process before the deadline.</p>",
      "<p>The Last date of application is 20 February 2026. Late forms will not be accepted under any circumstances whatsoever.</p>",
      "<p>Candidates who have completed a Bachelor's degree in Engineering are eligible to apply for the examination.</p>",
      "<p>Candidates holding an M.Sc. or equivalent Master's degree in Science may also apply for the examination.</p>",
      "</body></html>",
    ].join("");
    const result = await runExtractionPipeline(ADAPTER, {
      rawDocuments: [stagedDoc({ url: "http://127.0.0.1/multi.html", content: html })],
      year: 2026,
    });
    assert.ok(validateExamEdition(result.edition).success);
    assert.equal(result.edition.eligibility.education.status, "UNKNOWN");
    assert.equal(result.edition.eligibility.education.minLevel, null);
    assert.ok(result.edition.eligibility.education.evidence);
    assert.match(result.edition.eligibility.education.evidence.excerpt, /\[Graduate\]/);
    assert.match(result.edition.eligibility.education.evidence.excerpt, /\[Post-Graduate\]/);
    // Dates are unaffected by the education ambiguity.
    assert.equal(
      result.edition.registration.startDate.toISOString(),
      "2026-01-15T00:00:00.000Z"
    );
  });

  it("reads staged RawDocuments from an isolated database", async () => {
    const { mongod, mongoUri } = await startIsolatedDb("phase5_pipeline");
    const { connection, RawDocument } = await connectRawDocuments(mongoUri);
    try {
      const { document } = await saveRawDocument(RawDocument, stagedDoc());
      assert.ok(document.checksum);

      const result = await runExtractionPipeline(ADAPTER, { mongoUri });
      assert.equal(
        result.edition.registration.startDate.toISOString(),
        "2026-01-15T00:00:00.000Z"
      );
      assert.ok(validateExamEdition(result.edition).success);
      // Staging history untouched: still exactly one RawDocument.
      assert.equal(await RawDocument.countDocuments({}), 1);
    } finally {
      await closeIsolatedDb({ mongod, connection });
    }
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0);
  });

  it("never references production/demo Exam storage", () => {
    const sources = [
      "pipeline/extractionPipeline.js",
      "extractors/registrationDates.js",
      "extractors/eligibility.js",
      "extractors/evidence.js",
      "normalizers/dates.js",
    ];
    for (const relative of sources) {
      const code = fs.readFileSync(
        path.join(__dirname, "..", relative),
        "utf8"
      );
      assert.ok(
        !/require\(["'][^"']*server\//.test(code),
        `${relative} must not import server code`
      );
      assert.ok(!/models\/Exam/.test(code), `${relative} must not touch the Exam model`);
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
