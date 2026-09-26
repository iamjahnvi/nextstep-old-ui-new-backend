const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const clientViewModel = fs.readFileSync(
  path.join(__dirname, "../../client/src/pages/freshnessDashboardViewModel.js"),
  "utf8"
);
const dashboardPage = fs.readFileSync(
  path.join(__dirname, "../../client/src/pages/FreshnessDashboard.jsx"),
  "utf8"
);

describe("STEP 27 — freshness dashboard integration hardening", () => {
  it("uses the existing Step 25 GET endpoint and has no mutation controls", () => {
    assert.match(dashboardPage, /api\.get\("scraper\/freshness"/);
    assert.doesNotMatch(dashboardPage, /api\.(post|put|patch|delete)\(/);
    assert.doesNotMatch(dashboardPage, /\b(UPDATE|RETIRE|PUBLISH|RESOLVE)\b/);
  });

  it("keeps freshness values in the endpoint response boundary", () => {
    assert.match(clientViewModel, /data\.results\.map\(normalizeResult\)/);
    assert.doesNotMatch(clientViewModel, /function\s+(statusOf|computeFreshnessStatus)/);
  });

  it("does not import or invoke scraper execution paths", () => {
    assert.doesNotMatch(dashboardPage, /\b(fetch|probe|surveillance|extract|publish|resolve|schedule)\s*\(/i);
  });

  it("renders the read-only operational summary and attention section", () => {
    assert.match(dashboardPage, /OperationalSummary/);
    assert.match(dashboardPage, /activeDeclarations/);
    assert.match(dashboardPage, /retiredDeclarations/);
    assert.match(dashboardPage, /REVIEW_REQUIRED|FAILED/);
  });
});
