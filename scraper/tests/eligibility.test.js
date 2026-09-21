// =============================================================================
// scraper/tests/eligibility.test.js
// =============================================================================
// WHAT: Unit tests for rule-based eligibility extraction (no DB).
// WHY: Locks the Phase 5 contract — explicit signals become KNOWN with
//   evidence; everything else stays UNKNOWN (never invented) — plus the
//   Phase 12 multi-category rule: distinct education levels collapse to
//   UNKNOWN with preserved excerpts, never to a guessed single minimum.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { extractEligibility } = require("../extractors/eligibility");
const { validateEvidence } = require("../validators/examValidator");

const CTX = {
  sourceUrl: "http://127.0.0.1/",
  documentUrl: "http://127.0.0.1/bulletin",
  docType: "HTML",
  retrievedAt: new Date("2026-01-01T00:00:00Z"),
  section: "bulletin",
};

// Test-local vocabulary mirroring the JEE adapter values (the unit suite
// must not depend on any one exam's registry file).
const TEST_VOCAB = {
  subjectVocabulary: [
    { canonical: "Physics", match: ["physics"] },
    { canonical: "Chemistry", match: ["chemistry"] },
    { canonical: "Mathematics", match: ["mathematics", "maths", "math"] },
    { canonical: "Biology", match: ["biology"] },
    { canonical: "Computer Science", match: ["computer science"] },
  ],
  streamVocabulary: [{ canonical: "Science", match: ["science stream"] }],
};

function statuses(eligibility) {
  return Object.fromEntries(
    Object.entries(eligibility).map(([axis, value]) => [axis, value.status])
  );
}

describe("Phase 5 — extractEligibility", () => {
  it("extracts education, percentage, age, stream and subjects with evidence", () => {
    const text = [
      "Candidates must have passed 10+2 with Physics, Chemistry and Mathematics.",
      "A minimum of 75% marks in aggregate is required.",
      "Minimum age is 17 years. Applicants must be from the Science stream.",
    ].join(" ");
    const eligibility = extractEligibility(text, CTX, TEST_VOCAB);

    assert.equal(eligibility.education.status, "KNOWN");
    assert.equal(eligibility.education.minLevel, "12");
    assert.equal(eligibility.percentage.status, "KNOWN");
    assert.equal(eligibility.percentage.min, 75);
    assert.equal(eligibility.age.status, "KNOWN");
    assert.equal(eligibility.age.min, 17);
    assert.equal(eligibility.stream.status, "KNOWN");
    assert.deepEqual(eligibility.stream.allowed, ["Science"]);
    assert.equal(eligibility.subjects.status, "KNOWN");
    assert.deepEqual(eligibility.subjects.requiredAny, [
      "Physics",
      "Chemistry",
      "Mathematics",
    ]);

    for (const axis of Object.values(eligibility)) {
      if (axis.status === "KNOWN") {
        assert.ok(validateEvidence(axis.evidence).success);
      }
    }
  });

  it("keeps KNOWN when several mentions imply the same level", () => {
    const eligibility = extractEligibility(
      "Candidates must have passed the 12th standard examination. Admission requires Class 12 completion from any recognized board.",
      CTX
    );
    assert.equal(eligibility.education.status, "KNOWN");
    assert.equal(eligibility.education.minLevel, "12");
    assert.ok(validateEvidence(eligibility.education.evidence).success);
  });

  it("recognizes Roman-numeral class levels and equivalents", () => {
    const cases = [
      ["Candidates must have passed Class X from a recognized board.", "10"],
      ["Admission requires Class XI completion.", "11"],
      ["Candidates must have passed Class XII from a recognized board.", "12"],
      ["Senior Secondary examination passed.", "12"],
      ["10 + 2 system completed.", "12"],
      ["12th standard passed.", "12"],
    ];
    for (const [text, level] of cases) {
      const eligibility = extractEligibility(text, CTX);
      assert.equal(eligibility.education.status, "KNOWN", text);
      assert.equal(eligibility.education.minLevel, level, text);
      assert.ok(validateEvidence(eligibility.education.evidence).success);
    }
  });

  it("keeps mixed Roman-numeral categories UNKNOWN instead of guessing", () => {
    const eligibility = extractEligibility(
      "Class X passed candidates may apply for the foundation course. Class XII completion is required for the main post.",
      CTX
    );
    assert.equal(eligibility.education.status, "UNKNOWN");
    assert.equal(eligibility.education.minLevel, null);
    assert.ok(eligibility.education.evidence);
  });

  it("returns UNKNOWN (not most-demanding) for distinct category levels", () => {
    // Phase 12 rule change: two distinct levels used to collapse to the
    // highest rank ("Graduate"). The single-minLevel schema cannot hold
    // alternatives, so the honest result is UNKNOWN with both excerpts kept.
    const eligibility = extractEligibility(
      "Applicants who passed Class 10 may apply for the foundation course. Graduation is required for the main post.",
      CTX
    );
    assert.equal(eligibility.education.status, "UNKNOWN");
    assert.equal(eligibility.education.minLevel, null);
    assert.ok(eligibility.education.evidence);
    assert.equal(eligibility.education.evidence.confidence, "LOW");
    assert.ok(validateEvidence(eligibility.education.evidence).success);
    assert.match(eligibility.education.evidence.excerpt, /\[10\]/);
    assert.match(eligibility.education.evidence.excerpt, /\[Graduate\]/);
  });

  it("no longer reports Post-Graduate as the minimum for mixed degree lists", () => {
    // GATE-style multi-category page: bachelor's AND master's programs are
    // both listed as eligible categories. Neither level may pose as the
    // universal minimum.
    const eligibility = extractEligibility(
      [
        "Candidates who have completed a Bachelor's degree in Engineering are eligible to apply for the examination.",
        "Candidates holding an M.Sc. or equivalent Master's degree in Science may also apply for the examination.",
      ].join(" "),
      CTX
    );
    assert.equal(eligibility.education.status, "UNKNOWN");
    assert.equal(eligibility.education.minLevel, null);
    assert.notEqual(eligibility.education.minLevel, "Post-Graduate");
    const excerpt = eligibility.education.evidence.excerpt;
    assert.match(excerpt, /\[Graduate\]/);
    assert.match(excerpt, /\[Post-Graduate\]/);
  });

  it("flags DOB cutoffs as NEEDS_VERIFICATION without inventing ints", () => {
    const eligibility = extractEligibility(
      "Candidates born on or after 1 October 2001 are eligible to apply.",
      CTX
    );
    assert.equal(eligibility.age.status, "NEEDS_VERIFICATION");
    assert.equal(eligibility.age.min, null);
    assert.equal(eligibility.age.max, null);
    assert.ok(validateEvidence(eligibility.age.evidence).success);
  });

  it("rejects out-of-range percentages instead of recording them", () => {
    const eligibility = extractEligibility(
      "A minimum of 150% marks is required for consideration.",
      CTX
    );
    assert.equal(eligibility.percentage.status, "UNKNOWN");
    assert.equal(eligibility.percentage.min, null);
  });

  it("leaves everything UNKNOWN on empty input", () => {
    assert.deepEqual(statuses(extractEligibility("", CTX)), {
      education: "UNKNOWN",
      stream: "UNKNOWN",
      subjects: "UNKNOWN",
      percentage: "UNKNOWN",
      age: "UNKNOWN",
    });
  });
});
