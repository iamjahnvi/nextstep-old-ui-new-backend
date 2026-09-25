// =============================================================================
// scraper/tests/contextExtraction.test.js
// =============================================================================
// WHAT: STEP 6 tests — context-aware education extraction (date/age/page
//   noise suppression), section-aware confidence, evidence preservation, and
//   deterministic cross-document reconciliation (RESOLVED | CONFLICT |
//   INSUFFICIENT_EVIDENCE).
// WHY: Numbers without context lie: "8th September, 2008" is a date, not a
//   level-8 requirement; and later documents must not silently overwrite
//   earlier ones without explicit revision evidence.
// DB: none — pure functions over inline fixtures.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { extractEligibility } = require("../extractors/eligibility");
const { buildUnknownEligibility } = require("../validators/examValidator");
const { noiseContext } = require("../extractors/contextFilters");
const { detectSections, classifySection, sectionAt } = require("../extractors/sections");
const { reconcileField, RESOLUTION_STATUSES } = require("../extractors/reconciliation");

const CTX = {
  sourceUrl: "http://127.0.0.1/",
  documentUrl: "http://127.0.0.1/bulletin.html",
  docType: "HTML",
  retrievedAt: new Date("2026-01-02T00:00:00Z"),
  section: "information-bulletin",
};
const VOCAB = { subjectVocabulary: [], streamVocabulary: [] };

function evidence(docLabel, excerpt, retrievedAt) {
  return {
    sourceUrl: "http://127.0.0.1/",
    documentUrl: `http://127.0.0.1/${docLabel}.html`,
    docType: "HTML",
    retrievedAt: retrievedAt || new Date("2026-01-02T00:00:00Z"),
    section: docLabel,
    page: null,
    excerpt,
    confidence: "MEDIUM",
    extractor: "registrationDates.v1",
  };
}

describe("STEP 6 — noise suppression (dates, ages, pagination)", () => {
  it("1. '8th September, 2008' is a date, never education level 8", () => {
    const eligibility = extractEligibility(
      "Your password is 8th September, 2008 for illustration. Candidates must have passed Class 12.",
      CTX,
      VOCAB
    );
    assert.equal(eligibility.education.status, "KNOWN");
    assert.equal(eligibility.education.minLevel, "12");
  });

  it("2. a lone ordinal date yields UNKNOWN, not level 8", () => {
    const eligibility = extractEligibility("Notice dated 8th September, 2008.", CTX, VOCAB);
    assert.equal(eligibility.education.status, "UNKNOWN");
    assert.equal(eligibility.education.minLevel, null);
  });

  it("3. '17 years' is an age, never education level 17", () => {
    const eligibility = extractEligibility(
      "Candidates must be 17 years old on the cutoff date.",
      CTX,
      VOCAB
    );
    assert.equal(eligibility.education.status, "UNKNOWN");
    assert.equal(eligibility.education.minLevel, null);
    assert.notEqual(eligibility.education.minLevel, "17");
  });

  it("4. page and section numbers never become education levels", () => {
    for (const text of [
      "See Page 8 for the application form. Candidates must have passed Class 12.",
      "Refer Section 8 for fee details. Candidates must have passed Class 12.",
    ]) {
      const eligibility = extractEligibility(text, CTX, VOCAB);
      assert.equal(eligibility.education.minLevel, "12", text);
    }
    const bare = extractEligibility("Continued on Page 8.", CTX, VOCAB);
    assert.equal(bare.education.status, "UNKNOWN");
    assert.equal(bare.education.minLevel, null);
  });

  it("5. valid signals still extract: Class 12, Class XII, 10+2", () => {
    const cases = [
      ["Candidates must have passed Class 12 from a recognized board.", "12"],
      ["Candidates must have passed Class XII from a recognized board.", "12"],
      ["Candidates must have completed 10+2 from a recognized board.", "12"],
      ["Senior Secondary examination passed.", "12"],
      ["Higher Secondary examination passed.", "12"],
    ];
    for (const [text, level] of cases) {
      const eligibility = extractEligibility(text, CTX, VOCAB);
      assert.equal(eligibility.education.status, "KNOWN", text);
      assert.equal(eligibility.education.minLevel, level, text);
    }
  });

  it("6. Class 8 counts only in a clearly educational context", () => {
    const valid = extractEligibility("Minimum qualification: Class 8 pass from a recognized school.", CTX, VOCAB);
    assert.equal(valid.education.status, "KNOWN");
    assert.equal(valid.education.minLevel, "8");
    // The same ordinal inside a date is noise even next to real text.
    const noisy = extractEligibility(
      "Born on 8th September, 2008. Minimum qualification: Class 8 pass.",
      CTX,
      VOCAB
    );
    assert.equal(noisy.education.minLevel, "8");
  });

  it("7. genuinely ambiguous education text stays UNKNOWN", () => {
    const eligibility = extractEligibility(
      "Class 10 pass may apply for the foundation course. Class 12 required for the main post.",
      CTX,
      VOCAB
    );
    assert.equal(eligibility.education.status, "UNKNOWN");
    assert.equal(eligibility.education.minLevel, null);
    assert.ok(eligibility.education.evidence);
  });

  it("8. noiseContext classifies date, age, pagination, and clean spans", () => {
    const dateText = "Password 8th September, 2008 shown";
    const dateIdx = dateText.indexOf("8th");
    assert.equal(noiseContext(dateText, dateIdx, 3, "8th").kind, "date");
    const ageText = "Must be 17 years old to apply here";
    const ageIdx = ageText.indexOf("17");
    assert.equal(noiseContext(ageText, ageIdx, 2, "17").kind, "age");
    const pageText = "Refer Page 8th for the annexure";
    const pageIdx = pageText.indexOf("8th");
    assert.equal(noiseContext(pageText, pageIdx, 3, "8th").kind, "pagination");
    const cleanText = "Must have passed Class 12 from a board";
    const cleanIdx = cleanText.indexOf("Class 12");
    assert.equal(noiseContext(cleanText, cleanIdx, 8, "Class 12"), null);
  });
});

describe("STEP 6 — section awareness", () => {
  it("9. Class 12 inside an eligibility section wins HIGH confidence", () => {
    const text = "ELIGIBILITY\nCandidates must have passed Class 12 from a recognized board.";
    const eligibility = extractEligibility(text, CTX, VOCAB);
    assert.equal(eligibility.education.status, "KNOWN");
    assert.equal(eligibility.education.minLevel, "12");
    assert.equal(eligibility.education.evidence.confidence, "HIGH");
  });

  it("10. the same signal outside any section stays MEDIUM", () => {
    const eligibility = extractEligibility(
      "Candidates must have passed Class 12 from a recognized board.",
      CTX,
      VOCAB
    );
    assert.equal(eligibility.education.evidence.confidence, "MEDIUM");
  });

  it("11. section detection and classification are reusable", () => {
    const sections = detectSections(
      "ELIGIBILITY\nMust have passed Class 12.\nAGE LIMIT\nMinimum 17 years.\nSome body text here."
    );
    assert.ok(sections.length >= 2);
    assert.equal(sections[0].name, "ELIGIBILITY");
    assert.equal(sections[0].axis, "ELIGIBILITY");
    const age = sections.find((s) => s.axis === "AGE");
    assert.ok(age);
    assert.equal(classifySection("Important Dates"), "DATES");
    assert.equal(classifySection("Random paragraph heading"), "GENERAL");
    const hit = sectionAt(sections[0].start + 1, sections);
    assert.equal(hit.axis, "ELIGIBILITY");
    assert.equal(sectionAt(100000, sections), null);
  });

  it("12. year-led body lines are not misread as headings", () => {
    const sections = detectSections("2026 session begins in January.\nELIGIBILITY\nClass 12 required.");
    assert.deepEqual(sections.map((s) => s.name), ["ELIGIBILITY"]);
  });
});

describe("STEP 6 — evidence preservation", () => {
  it("13. education evidence keeps source, excerpt, rule, and confidence", () => {
    const eligibility = extractEligibility(
      "ELIGIBILITY\nCandidates must have passed Class 12 from a recognized board.",
      CTX,
      VOCAB
    );
    const ev = eligibility.education.evidence;
    assert.equal(ev.sourceUrl, CTX.sourceUrl);
    assert.equal(ev.documentUrl, CTX.documentUrl);
    assert.equal(ev.docType, "HTML");
    assert.equal(ev.section, "information-bulletin");
    assert.ok(ev.excerpt.includes("Class 12"));
    assert.equal(ev.extractor, "eligibility.v1");
    assert.equal(ev.confidence, "HIGH");
  });
});

describe("STEP 6 — cross-document reconciliation", () => {
  it("14. unanimous values resolve with all evidence kept", () => {
    const out = reconcileField({
      field: "registrationEnd",
      candidates: [
        { value: "2026-01-10T00:00:00.000Z", evidence: evidence("bulletin", "last date 10 Jan"), docLabel: "bulletin", documentUrl: "http://127.0.0.1/bulletin.html", fetchedAt: new Date("2026-01-02T00:00:00Z") },
        { value: "2026-01-10T00:00:00.000Z", evidence: evidence("notice", "last date 10 Jan"), docLabel: "notice", documentUrl: "http://127.0.0.1/notice.html", fetchedAt: new Date("2026-01-03T00:00:00Z") },
      ],
    });
    assert.equal(out.status, "RESOLVED");
    assert.equal(out.selectedValue, "2026-01-10T00:00:00.000Z");
    assert.equal(out.reason, "unanimous across documents");
    assert.equal(out.evidence.length, 2);
  });

  it("15. an explicit revision supersedes the original", () => {
    const out = reconcileField({
      field: "registrationEnd",
      candidates: [
        { value: "2026-01-10T00:00:00.000Z", evidence: evidence("bulletin", "last date 10 Jan"), docLabel: "bulletin", documentUrl: "http://127.0.0.1/bulletin.html", fetchedAt: new Date("2026-01-02T00:00:00Z") },
        { value: "2026-01-15T00:00:00.000Z", evidence: evidence("revised", "revised last date 15 Jan"), docLabel: "revised-bulletin", documentUrl: "http://127.0.0.1/revised.html", fetchedAt: new Date("2026-01-05T00:00:00Z"), revision: true },
      ],
    });
    assert.equal(out.status, "RESOLVED");
    assert.equal(out.selectedValue, "2026-01-15T00:00:00.000Z");
    assert.equal(out.reason, "explicit revision supersedes earlier documents");
  });

  it("16. corrigendum values resolve the same way", () => {
    const out = reconcileField({
      field: "registrationEnd",
      candidates: [
        { value: "2026-01-10T00:00:00.000Z", evidence: evidence("bulletin", "10 Jan"), docLabel: "bulletin", documentUrl: "http://127.0.0.1/a.html", fetchedAt: new Date("2026-01-02T00:00:00Z") },
        { value: "2026-01-12T00:00:00.000Z", evidence: evidence("corrigendum", "corrigendum: 12 Jan"), docLabel: "corrigendum", documentUrl: "http://127.0.0.1/b.html", fetchedAt: new Date("2026-01-04T00:00:00Z"), revision: true },
      ],
    });
    assert.equal(out.status, "RESOLVED");
    assert.equal(out.selectedValue, "2026-01-12T00:00:00.000Z");
  });

  it("17. unexplained conflicts stay CONFLICT with everything preserved", () => {
    const out = reconcileField({
      field: "registrationEnd",
      candidates: [
        { value: "2026-01-10T00:00:00.000Z", evidence: evidence("a", "10 Jan"), docLabel: "a", documentUrl: "http://127.0.0.1/a.html", fetchedAt: new Date("2026-01-02T00:00:00Z") },
        { value: "2026-01-15T00:00:00.000Z", evidence: evidence("b", "15 Jan"), docLabel: "b", documentUrl: "http://127.0.0.1/b.html", fetchedAt: new Date("2026-01-03T00:00:00Z") },
      ],
    });
    assert.equal(out.status, "CONFLICT");
    assert.equal(out.selectedValue, null);
    assert.equal(out.reason, "distinct values without explicit revision");
    assert.equal(out.evidence.length, 2);
    assert.equal(out.candidates.length, 2);
  });

  it("18. empty input is INSUFFICIENT_EVIDENCE, never a guess", () => {
    for (const candidates of [[], [{ value: null, evidence: null }]]) {
      const out = reconcileField({ field: "registrationEnd", candidates });
      assert.equal(out.status, "INSUFFICIENT_EVIDENCE");
      assert.equal(out.selectedValue, null);
    }
    assert.deepEqual(RESOLUTION_STATUSES, ["RESOLVED", "CONFLICT", "INSUFFICIENT_EVIDENCE"]);
  });

  it("19. reconciliation is deterministic regardless of input order", () => {
    const a = { value: "2026-01-10T00:00:00.000Z", evidence: evidence("a", "10 Jan"), docLabel: "a", documentUrl: "http://127.0.0.1/a.html", fetchedAt: new Date("2026-01-02T00:00:00Z") };
    const b = { value: "2026-01-15T00:00:00.000Z", evidence: evidence("b", "15 Jan"), docLabel: "b", documentUrl: "http://127.0.0.1/b.html", fetchedAt: new Date("2026-01-03T00:00:00Z") };
    const first = reconcileField({ field: "f", candidates: [a, b] });
    const second = reconcileField({ field: "f", candidates: [b, a] });
    assert.deepEqual(first, second);
  });
});

describe("STEP 6 — boundaries", () => {
  it("20. context and reconciliation modules stay generic and side-effect free", () => {
    for (const relative of [
      "extractors/contextFilters.js",
      "extractors/sections.js",
      "extractors/reconciliation.js",
    ]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      const executable = code
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
        .replace(/\/\/.*$/gm, "");
      assert.ok(
        !/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable),
        `${relative} must not name exams or boards`
      );
      assert.ok(!/require\(["'].*(publish|mongoose|crawlee|axios|playwright)["']\)/.test(code));
    }
    // Untouched pipeline surface: reconciliation is available but not wired
    // into extraction output shapes in this step.
    assert.deepEqual(Object.keys(buildUnknownEligibility()).sort(), ["age", "education", "percentage", "stream", "subjects"]);
  });
});
