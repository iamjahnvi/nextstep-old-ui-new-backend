// =============================================================================
// scraper/tests/adapterVocabulary.test.js
// =============================================================================
// WHAT: Phase 19 tests — subject/stream vocabularies live in adapter config
//   and drive the generic extractor; unknown values stay UNKNOWN.
// WHY: Locks the audit fix — future exams extend recognition through their
//   registry file, never through extractor code — while proving JEE output
//   is unchanged and GATE inherits nothing JEE-specific.
// DB: none for unit parts; one isolated runExtractionPipeline call uses
//   options.rawDocuments (no database connection at all).
// RUN: npm test (node --test)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  SourceAdapterConfigSchema,
  validateAdapterConfig,
} = require("../registry/schema");
const { extractEligibility } = require("../extractors/eligibility");
const { runExtractionPipeline } = require("../pipeline/extractionPipeline");
const { validateEvidence } = require("../validators/examValidator");
const jeeAdapter = require("../registry/exams/jee-main");
const gateAdapter = require("../registry/exams/gate-2026");

const CTX = {
  sourceUrl: "http://127.0.0.1/",
  documentUrl: "http://127.0.0.1/bulletin",
  docType: "HTML",
  retrievedAt: new Date("2026-01-01T00:00:00Z"),
  section: "bulletin",
};

const JEE_TEXT = [
  "Candidates must have passed 10+2 with Physics, Chemistry and Mathematics.",
  "A minimum of 75% marks in aggregate is required.",
  "Minimum age is 17 years. Applicants must be from the Science stream.",
].join(" ");

function baseAdapter(overrides = {}) {
  return {
    slug: "phase19-test-exam",
    name: "Phase19 Test Exam",
    fullForm: "Phase Nineteen Test Examination",
    conductingBody: "Phase Nineteen Test Board",
    officialWebsite: "http://127.0.0.1/",
    startUrls: ["http://127.0.0.1/"],
    render: "static",
    ...overrides,
  };
}

function stagedDoc(content) {
  return {
    label: "information-bulletin",
    url: "http://127.0.0.1/bulletin.html",
    sourceUrl: "http://127.0.0.1/",
    type: "HTML",
    contentType: "text/html",
    fetchedAt: new Date("2026-01-02T00:00:00Z"),
    status: 200,
    content,
  };
}

describe("Phase 19 — adapter-supplied subject/stream vocabularies", () => {
  it("1. schema accepts valid vocabularies and defaults them to []", () => {
    const parsed = SourceAdapterConfigSchema.parse(
      baseAdapter({
        subjectVocabulary: [
          { canonical: "Physics", match: ["physics", "phys."] },
        ],
        streamVocabulary: [{ canonical: "Science", match: ["science stream"] }],
      })
    );
    assert.deepEqual(parsed.subjectVocabulary, [
      { canonical: "Physics", match: ["physics", "phys."] },
    ]);
    const defaulted = SourceAdapterConfigSchema.parse(baseAdapter());
    assert.deepEqual(defaulted.subjectVocabulary, []);
    assert.deepEqual(defaulted.streamVocabulary, []);
    assert.ok(validateAdapterConfig(jeeAdapter).success);
    assert.ok(validateAdapterConfig(gateAdapter).success);
  });

  it("2. invalid vocabulary configuration is rejected", () => {
    for (const bad of [
      { subjectVocabulary: [{ canonical: "", match: ["physics"] }] },
      { subjectVocabulary: [{ canonical: "Physics", match: [] }] },
      { subjectVocabulary: [{ canonical: "Physics", match: ["ok"], extra: 1 }] },
      { subjectVocabulary: "physics" },
      { streamVocabulary: [{ canonical: 42, match: ["science stream"] }] },
    ]) {
      assert.equal(
        SourceAdapterConfigSchema.safeParse(baseAdapter(bad)).success,
        false,
        JSON.stringify(bad)
      );
    }
  });

  it("3. JEE vocabulary produces equivalent existing behavior", () => {
    const eligibility = extractEligibility(JEE_TEXT, CTX, {
      subjectVocabulary: jeeAdapter.subjectVocabulary,
      streamVocabulary: jeeAdapter.streamVocabulary,
    });
    assert.equal(eligibility.stream.status, "KNOWN");
    assert.deepEqual(eligibility.stream.allowed, ["Science"]);
    assert.equal(eligibility.subjects.status, "KNOWN");
    assert.deepEqual(eligibility.subjects.requiredAny, [
      "Physics",
      "Chemistry",
      "Mathematics",
    ]);
    assert.ok(validateEvidence(eligibility.stream.evidence).success);
    assert.ok(validateEvidence(eligibility.subjects.evidence).success);
  });

  it("4. GATE inherits no JEE vocabulary", () => {
    assert.deepEqual(gateAdapter.subjectVocabulary, []);
    assert.deepEqual(gateAdapter.streamVocabulary, []);
    const eligibility = extractEligibility(JEE_TEXT, CTX, {
      subjectVocabulary: gateAdapter.subjectVocabulary,
      streamVocabulary: gateAdapter.streamVocabulary,
    });
    assert.equal(eligibility.stream.status, "UNKNOWN");
    assert.equal(eligibility.stream.allowed, null);
    assert.equal(eligibility.subjects.status, "UNKNOWN");
    assert.equal(eligibility.subjects.requiredAny, null);
    // Education/percentage/age axes are vocabulary-independent.
    assert.equal(eligibility.education.minLevel, "12");
    assert.equal(eligibility.percentage.min, 75);
  });

  it("5. adapter vocabulary reaches the extractor through the pipeline", async () => {
    const html = [
      "<html><head><title>Bulletin</title></head><body>",
      "<p>Applicants must be from the Commerce stream to be considered eligible for counselling.</p>",
      "</body></html>",
    ].join("");
    const result = await runExtractionPipeline(
      baseAdapter({
        streamVocabulary: [{ canonical: "Commerce", match: ["commerce stream"] }],
      }),
      { rawDocuments: [stagedDoc(html)], year: 2026, cycle: "2026" }
    );
    assert.equal(result.edition.eligibility.stream.status, "KNOWN");
    assert.deepEqual(result.edition.eligibility.stream.allowed, ["Commerce"]);
    // The same text under an empty vocabulary stays UNKNOWN.
    const plain = await runExtractionPipeline(baseAdapter(), {
      rawDocuments: [stagedDoc(html)],
      year: 2026,
      cycle: "2026",
    });
    assert.equal(plain.edition.eligibility.stream.status, "UNKNOWN");
  });

  it("6. missing/empty vocabulary and unknown values fail safe to UNKNOWN", () => {
    const unknownText =
      "Applicants must be from the Arts stream with History, Geography and Civics as core subjects.";
    for (const vocab of [undefined, {}, { subjectVocabulary: [], streamVocabulary: [] }]) {
      const eligibility = extractEligibility(JEE_TEXT, CTX, vocab);
      assert.equal(eligibility.stream.status, "UNKNOWN");
      assert.equal(eligibility.subjects.status, "UNKNOWN");
    }
    const jeeVocab = {
      subjectVocabulary: jeeAdapter.subjectVocabulary,
      streamVocabulary: jeeAdapter.streamVocabulary,
    };
    const eligibility = extractEligibility(unknownText, CTX, jeeVocab);
    assert.equal(eligibility.stream.status, "UNKNOWN");
    assert.equal(eligibility.stream.allowed, null);
    assert.equal(eligibility.subjects.status, "UNKNOWN");
    assert.equal(eligibility.subjects.requiredAny, null);
  });

  it("7. no hardcoded subject/stream literals remain in generic code", () => {
    for (const relative of [
      "extractors/eligibility.js",
      "pipeline/extractionPipeline.js",
    ]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      const executable = code.replace(/\/\/.*$/gm, "");
      assert.ok(
        !/physics|chemistry|mathematics|maths|biology|computer science|science\s+stream/i.test(
          executable
        ),
        `${relative} must not hardcode vocabulary`
      );
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
