// =============================================================================
// scraper/tests/pilotExpansion.test.js
// =============================================================================
// WHAT: STEP 19 tests — expansion-gate tally from per-source outcomes
//   (PASSED / PASSED WITH RESTRICTIONS / BLOCKED). Stops always win; FAILs
//   and open reviews become named restrictions; unanimous PASS is the only
//   unrestricted path.
// WHY: The final gate must be computed, not felt: a breached safety gate can
//   never be outvoted by passing sources, and every restriction is explicit.
// DB: none — pure function over stub outcomes.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { EXPANSION_GATES, summarizeExpansion } = require("../pilot/reporting");

describe("STEP 19 — expansion gate", () => {
  it("1. unanimous PASS gates PASSED", () => {
    assert.deepEqual(EXPANSION_GATES, ["PASSED", "PASSED WITH RESTRICTIONS", "BLOCKED"]);
    const out = summarizeExpansion([
      { slug: "a", verdict: "PASS", stopTriggered: false },
      { slug: "b", verdict: "PASS", stopTriggered: false },
    ]);
    assert.equal(out.decision, "PASSED");
    assert.deepEqual(out.restrictions, []);
  });

  it("2. open reviews and FAILs become named restrictions", () => {
    const out = summarizeExpansion([
      { slug: "gate-2026", verdict: "PASS_WITH_REVIEW", stopTriggered: false },
      { slug: "jee-main", verdict: "FAIL", stopTriggered: false, restriction: "browser transport selection" },
    ]);
    assert.equal(out.decision, "PASSED WITH RESTRICTIONS");
    assert.equal(out.restrictions.length, 2);
    assert.ok(out.restrictions.some((r) => r.includes("jee-main")));
  });

  it("3. any breached stop gate blocks unconditionally", () => {
    const out = summarizeExpansion([
      { slug: "a", verdict: "PASS", stopTriggered: false },
      { slug: "b", verdict: "PASS", stopTriggered: true },
    ]);
    assert.equal(out.decision, "BLOCKED");
    assert.ok(out.reasons.some((r) => r.includes("b")));
  });

  it("4. malformed input fails loudly", () => {
    assert.throws(() => summarizeExpansion([]), /at least one source outcome/);
    assert.throws(() => summarizeExpansion([{ verdict: "PASS" }]), /needs a slug/);
    assert.throws(() => summarizeExpansion([{ slug: "a", verdict: "MAYBE" }]), /unknown verdict/);
  });
});
