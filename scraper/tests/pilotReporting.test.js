// =============================================================================
// scraper/tests/pilotReporting.test.js
// =============================================================================
// WHAT: STEP 15 tests — pilot audit builders (field verdicts, explicit metric
//   comparison, gap classification, verdict-derived sign-off) and pilot-runner
//   boundaries. The live pilot itself needs the network by definition and is
//   never part of the suite; everything assertable offline lives here.
// WHY: Operator verdicts and comparisons must be structurally sound: verdicts
//   constrained, comparability declared (never inferred), gaps typed, and
//   sign-off withheld on any non-accepted required field.
// DB: none — pure functions over stub data.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  FIELD_VERDICTS,
  COMPARABILITY,
  GAP_KINDS,
  newAuditRecord,
  recordField,
  compareMetric,
  recordGap,
  signOff,
} = require("../pilot/reporting");

describe("STEP 15 — pilot audit reporting", () => {
  it("1. audit records fields with constrained verdicts", () => {
    const audit = newAuditRecord({
      source: { slug: "s", authorityDomain: "example.gov", sourceUrl: "https://example.gov/" },
      exam: { name: "X", year: 2026, cycle: "2026" },
      runId: "run-1",
    });
    recordField(audit, { field: "education", value: "12", status: "KNOWN", evidence: { excerpt: "Class XII" }, verdict: "accepted" });
    recordField(audit, { field: "endDate", value: "2026-01-10", status: "KNOWN", evidence: null, verdict: null });
    assert.equal(audit.fields.length, 2);
    assert.equal(audit.fields[0].verdict, "accepted");
    assert.equal(audit.fields[1].verdict, null);
    assert.deepEqual(FIELD_VERDICTS, ["accepted", "rejected", "investigate"]);
    assert.throws(() => recordField(audit, { field: "x", verdict: "maybe" }), /verdict must be/);
    assert.throws(() => recordField(audit, {}), /field name is required/);
    assert.throws(() => newAuditRecord({}), /source and exam descriptors are required/);
  });

  it("2. metric comparability is declared, with three verdicts", () => {
    assert.deepEqual(COMPARABILITY, ["DIRECTLY COMPARABLE", "NOT COMPARABLE", "NEW OBSERVATION"]);
    assert.equal(compareMetric({ name: "m", baseline: 1, pilot: 1, comparable: true }).verdict, "DIRECTLY COMPARABLE");
    assert.equal(compareMetric({ name: "m", baseline: 1, pilot: 2, comparable: false }).verdict, "NOT COMPARABLE");
    assert.equal(compareMetric({ name: "m", pilot: 2, comparable: "new" }).verdict, "NEW OBSERVATION");
    assert.throws(() => compareMetric({ baseline: 1, comparable: true }), /metric name is required/);
    assert.throws(() => compareMetric({ name: "m", comparable: "sometimes" }), /comparable must be/);
  });

  it("3. gaps are typed across the five required kinds", () => {
    const audit = newAuditRecord({ source: { slug: "s" }, exam: { name: "X" } });
    for (const kind of GAP_KINDS) recordGap(audit, { kind, title: `${kind} example` });
    assert.equal(audit.gaps.length, 5);
    assert.throws(() => recordGap(audit, { kind: "MYSTERY", title: "x" }), /gap kind must be/);
    assert.throws(() => recordGap(audit, { kind: "BUG" }), /gap title is required/);
  });

  it("4. sign-off approves only fully accepted required fields", () => {
    const audit = newAuditRecord({ source: { slug: "s" }, exam: { name: "X" } });
    recordField(audit, { field: "startDate", value: "2026-01-10", verdict: "accepted" });
    recordField(audit, { field: "endDate", value: "2026-01-15", verdict: "investigate" });
    const held = signOff(audit, ["startDate", "endDate"]);
    assert.equal(held.decision, "withheld");
    assert.ok(held.reasons.some((r) => r.includes("endDate")));
    assert.equal(audit.signOff.decision, "withheld");
    const clean = newAuditRecord({ source: { slug: "s" }, exam: { name: "X" } });
    recordField(clean, { field: "startDate", value: "2026-01-10", verdict: "accepted" });
    assert.equal(signOff(clean, ["startDate"]).decision, "approved");
    const missing = newAuditRecord({ source: { slug: "s" }, exam: { name: "X" } });
    assert.equal(signOff(missing, ["startDate"]).decision, "withheld");
    const rejected = newAuditRecord({ source: { slug: "s" }, exam: { name: "X" } });
    recordField(rejected, { field: "startDate", value: "x", verdict: "rejected" });
    assert.equal(signOff(rejected, ["startDate"]).decision, "withheld");
  });

  it("5. pilot runner reuses the pipeline and publishes nothing by itself", () => {
    for (const relative of ["pilot/reporting.js", "pilot/pilotRun.js"]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      // pilotRun legitimately calls the existing publish boundary ONLY via the
      // explicit promoteAndPublish path (operator-signed); no auto-publish.
      assert.ok(!/setInterval|cron|BullMQ|kafka|redis/i.test(code.replace(/\/\/.*$/gm, "")), `${relative}: no scheduling infrastructure`);
      const executable = code
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
        .replace(/\/\/.*$/gm, "");
      assert.ok(!/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable), `${relative}: no exam names`);
    }
    const runner = fs.readFileSync(path.join(__dirname, "..", "pilot", "pilotRun.js"), "utf8");
    assert.ok(/require\(["']\.\.\/pipeline\/endToEndIngestion["']\)/.test(runner), "reuses single-exam ingestion");
    assert.ok(/require\(["']\.\.\/surveillance\/sourceSurveillance["']\)/.test(runner), "reuses surveillance");
    assert.ok(!/for\s*\(\s*(const|let|var)\s+\w+\s+of\s+.*[Ss]ources/.test(runner.replace(/\/\/.*$/gm, "")), "one source per call, no batch loop");
  });
});
