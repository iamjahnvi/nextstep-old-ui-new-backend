// =============================================================================
// scraper/tests/registrationDates.test.js
// =============================================================================
// WHAT: Unit tests for rule-based registration-date extraction (no DB).
// WHY: Locks the Phase 5 contract — explicit labels win with HIGH confidence,
//   ranges work with MEDIUM, bare/contradictory dates stay UNKNOWN (nulls).
// RUN: npm test (node --test)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { extractRegistrationDates } = require("../extractors/registrationDates");
const { validateEvidence } = require("../validators/examValidator");

const CTX = {
  sourceUrl: "http://127.0.0.1/",
  documentUrl: "http://127.0.0.1/bulletin",
  docType: "HTML",
  retrievedAt: new Date("2026-01-01T00:00:00Z"),
  section: "bulletin",
};

function iso(date) {
  return date && date.toISOString();
}

describe("Phase 5 — extractRegistrationDates", () => {
  it("extracts explicit start/end labels with HIGH confidence", () => {
    const text = [
      "Registration Start Date: 15 January 2026.",
      "The Last date of application is 20 February 2026.",
    ].join(" ");
    const { startDate, endDate, findings } = extractRegistrationDates(text, CTX);
    assert.equal(iso(startDate), "2026-01-15T00:00:00.000Z");
    assert.equal(iso(endDate), "2026-02-20T00:00:00.000Z");
    assert.ok(findings.every((f) => f.confidence === "HIGH"));
    assert.ok(findings.every((f) => f.evidence));
  });

  it("reads numeric DD/MM/YYYY and ISO shapes", () => {
    const { startDate } = extractRegistrationDates(
      "Application start date 15/01/2026, hurry.",
      CTX
    );
    assert.equal(iso(startDate), "2026-01-15T00:00:00.000Z");
    const isoRes = extractRegistrationDates(
      "Closing date 2026-02-20 for online forms.",
      CTX
    );
    assert.equal(iso(isoRes.endDate), "2026-02-20T00:00:00.000Z");
  });

  it("falls back to from/to ranges with MEDIUM confidence", () => {
    const { startDate, endDate, findings } = extractRegistrationDates(
      "Online registration will be open from 10 March 2026 to 25 March 2026 for all applicants.",
      CTX
    );
    assert.equal(iso(startDate), "2026-03-10T00:00:00.000Z");
    assert.equal(iso(endDate), "2026-03-25T00:00:00.000Z");
    assert.ok(findings.every((f) => f.confidence === "MEDIUM"));
  });

  it("ignores bare dates with no registration context", () => {
    const { startDate, endDate, findings } = extractRegistrationDates(
      "The bulletin was printed on 15 January 2026 and reprinted on 20 February 2026.",
      CTX
    );
    assert.equal(startDate, null);
    assert.equal(endDate, null);
    assert.deepEqual(findings, []);
  });

  it("nulls contradictory ranges instead of returning an invalid window", () => {
    const { startDate, endDate } = extractRegistrationDates(
      "Registration Start Date: 20 February 2026. Last date of application is 15 January 2026.",
      CTX
    );
    assert.equal(startDate, null);
    assert.equal(endDate, null);
  });

  it("rejects impossible calendar dates", () => {
    const { startDate } = extractRegistrationDates(
      "Registration Start Date: 31 February 2026.",
      CTX
    );
    assert.equal(startDate, null);
  });

  it("handles empty input as UNKNOWN", () => {
    assert.deepEqual(extractRegistrationDates("", CTX), {
      startDate: null,
      endDate: null,
      findings: [],
    });
  });

  it("prefers an explicitly revised date over the original", () => {
    const { startDate, endDate, findings } = extractRegistrationDates(
      [
        "Registration start date: 10 January 2026.",
        "Revised schedule: registration begins 25 January 2026.",
        "The Last date of application is 20 February 2026.",
      ].join(" "),
      CTX
    );
    assert.equal(iso(startDate), "2026-01-25T00:00:00.000Z");
    assert.equal(iso(endDate), "2026-02-20T00:00:00.000Z");
    const start = findings.find((f) => f.kind === "start");
    assert.equal(start.confidence, "HIGH");
    assert.match(start.excerpt, /revised/i);
    assert.ok(start.evidence);
  });

  it("prefers an explicitly extended deadline over the original", () => {
    const { endDate, findings } = extractRegistrationDates(
      [
        "The original deadline was 15 August 2025.",
        "The last date has been extended till 30 September 2025.",
      ].join(" "),
      CTX
    );
    assert.equal(iso(endDate), "2025-09-30T00:00:00.000Z");
    const end = findings.find((f) => f.kind === "end");
    assert.equal(end.confidence, "HIGH");
    assert.match(end.excerpt, /extended/i);
    assert.ok(end.evidence);
  });

  it("returns UNKNOWN with competing evidence when dates lack revision linkage", () => {
    const { startDate, endDate, findings } = extractRegistrationDates(
      [
        "Registration opens 10 March 2026 for early applicants.",
        "Late registration opens 20 March 2026 for remaining seats.",
      ].join(" "),
      CTX
    );
    assert.equal(startDate, null);
    assert.equal(endDate, null);
    assert.equal(findings.length, 1);
    const [only] = findings;
    assert.equal(only.kind, "start");
    assert.equal(only.confidence, "LOW");
    assert.equal(only.ambiguous, true);
    assert.match(only.excerpt, /10 March/);
    assert.match(only.excerpt, /20 March/);
    assert.ok(only.evidence);
    assert.equal(only.evidence.confidence, "LOW");
    assert.ok(validateEvidence(only.evidence).success);
  });

  it("ignores revision language unrelated to the target date", () => {
    const { startDate, endDate, findings } = extractRegistrationDates(
      [
        "Last date of application is 20 February 2026.",
        "The examination schedule is revised: exams will be held from 10 May 2026.",
      ].join(" "),
      CTX
    );
    assert.equal(startDate, null);
    assert.equal(iso(endDate), "2026-02-20T00:00:00.000Z");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "end");
  });

  it("holds no exam-specific literals in generic date extraction", () => {
    const code = fs.readFileSync(
      path.join(__dirname, "..", "extractors", "registrationDates.js"),
      "utf8"
    );
    const executable = code.replace(/\/\/.*$/gm, "");
    assert.ok(
      !/jee|gate-2026|\bnta\b|\biit\b|upsc|neet/i.test(executable),
      "generic date extraction must name no exam"
    );
  });
});
