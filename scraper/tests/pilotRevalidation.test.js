// =============================================================================
// scraper/tests/pilotRevalidation.test.js
// =============================================================================
// WHAT: STEP 17 tests — per-exam operational verdicts (PASS / PASS_WITH_REVIEW
//   / FAIL) plus the BUG-1 regression test for the Step 15 multi-revision
//   date cell (GATE regular-closing cell: Sep 25 → Sep 28 → Oct 06 → Oct 07).
// WHY: The Step 17 live re-run confirmed BUG-1 still reproduces (Oct 06
//   selected HIGH/AUTO_ACCEPTABLE instead of the last-listed Oct 07), and the
//   Step 16 calibration fix does not exist in this tree. The regression test
//   below is therefore marked todo: it documents the exact desired behavior
//   (last-listed revision wins, confidence downgraded on multi-date cells)
//   without breaking the suite it guards. Removing the todo marker is the
//   Step 16 fix's acceptance proof.
// DB: none — pure functions over recorded fixtures.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { EXAM_VERDICTS, newAuditRecord, recordField, gradeExam } = require("../pilot/reporting");
const { extractRegistrationDates } = require("../extractors/registrationDates");

const CTX = {
  sourceUrl: "https://gate2026.iitg.ac.in/",
  documentUrl: "https://gate2026.iitg.ac.in/important-dates.html",
  docType: "HTML",
  retrievedAt: new Date("2026-09-24T00:00:00Z"),
  section: "important-dates",
};

// Recorded live Step 15/17 fixture: four successive revisions concatenated in
// one table cell, no per-date revision labels.
const MULTI_REVISION_CELL =
  "Closing Date of REGULAR online registration application process Without Late Fee " +
  "ThursdaySundayMondayTuesday September 25, 2025September 28, 2025October 06, 2025October 07, 2025";

describe("STEP 17 — per-exam operational verdicts", () => {
  it("1. verdicts derive from operator field verdicts only", () => {
    assert.deepEqual(EXAM_VERDICTS, ["PASS", "PASS_WITH_REVIEW", "FAIL"]);
    const clean = newAuditRecord({ source: { slug: "s" }, exam: { name: "X" } });
    recordField(clean, { field: "startDate", value: "2025-08-28", verdict: "accepted" });
    assert.deepEqual(gradeExam(clean), { verdict: "PASS", reasons: [] });

    const open = newAuditRecord({ source: { slug: "s" }, exam: { name: "X" } });
    recordField(open, { field: "startDate", value: "2025-08-28", verdict: "accepted" });
    recordField(open, { field: "endDate", value: "2025-10-06", verdict: "investigate" });
    const held = gradeExam(open);
    assert.equal(held.verdict, "PASS_WITH_REVIEW");
    assert.ok(held.reasons.some((reason) => reason.includes("endDate")));

    const bad = newAuditRecord({ source: { slug: "s" }, exam: { name: "X" } });
    recordField(bad, { field: "endDate", value: "2026-01-10", verdict: "rejected" });
    assert.equal(gradeExam(bad).verdict, "FAIL");

    const empty = newAuditRecord({ source: { slug: "s" }, exam: { name: "X" } });
    assert.equal(gradeExam(empty).verdict, "FAIL");
    assert.throws(() => gradeExam(null), /audit record is required/);
  });
});

describe("STEP 18 — BUG-1 multi-revision date regression (fixed)", () => {
  it("2. last-listed revision wins with downgraded confidence", () => {
    // STEP 18 fix verified: in an undifferentiated multi-revision cell, the
    // last-listed valid revision wins below HIGH, so review always sees it.
    const found = extractRegistrationDates(MULTI_REVISION_CELL, CTX);
    assert.equal(found.endDate && found.endDate.toISOString(), "2025-10-07T00:00:00.000Z");
    const end = found.findings.find((item) => item.kind === "end");
    assert.ok(end);
    assert.notEqual(end.confidence, "HIGH");
  });

  it("3. single dates keep HIGH; sentences stay separate", () => {
    const single = extractRegistrationDates(
      "Registration Start Date: 15 January 2026. Last date of application is 20 February 2026.",
      CTX
    );
    assert.equal(single.startDate.toISOString(), "2026-01-15T00:00:00.000Z");
    assert.equal(single.endDate.toISOString(), "2026-02-20T00:00:00.000Z");
    assert.ok(single.findings.every((item) => item.confidence === "HIGH"));
  });

  it("4. explicit revision statements still win at HIGH when singular", () => {
    const revised = extractRegistrationDates(
      "Registration Start Date: 15 January 2026. Revised schedule: registration begins 25 January 2026.",
      CTX
    );
    assert.equal(revised.startDate.toISOString(), "2026-01-25T00:00:00.000Z");
  });

  it("5. bare extension clusters resolve to their last date", () => {
    const extended = extractRegistrationDates(
      "Registration window open. Last date extended till October 06, 2025October 09, 2025 for all applicants.",
      CTX
    );
    assert.equal(extended.endDate && extended.endDate.toISOString(), "2025-10-09T00:00:00.000Z");
  });

  it("6. a glued earlier date ends the cluster instead of winning it", () => {
    // Live Step 18 shape (notifications page): the trailing date belongs to
    // another event (brochure release), so the labeled date stands HIGH.
    const notice = extractRegistrationDates(
      "Registration Opens on August 28, 2025 August 24, 2025 Information Brochure is released August 21, 2025.",
      CTX
    );
    assert.equal(notice.startDate && notice.startDate.toISOString(), "2025-08-28T00:00:00.000Z");
    const start = notice.findings.find((item) => item.kind === "start");
    assert.equal(start && start.confidence, "HIGH");
  });
});
