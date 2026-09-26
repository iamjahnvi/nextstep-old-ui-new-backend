const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const worker = path.join(__dirname, "step30PersistenceWorker.js");

function runPhase(phase, env) {
  const result = spawnSync(process.execPath, [worker, phase], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || `STEP 30 ${phase} failed`);
  return JSON.parse(result.stdout);
}

describe("STEP 30 — persistent freshness/dashboard integration", () => {
  it("verifies persistence across separate application processes when explicitly configured", (t) => {
    const mongoUri = process.env.STEP30_MONGO_URI;
    if (!mongoUri) {
      t.skip("Set STEP30_MONGO_URI to an isolated persistent MongoDB database to run this verification");
      return;
    }
    assert.match(mongoUri, /step30/i, "STEP30_MONGO_URI must identify an isolated Step 30 database");
    const suffix = crypto.randomBytes(6).toString("hex");
    const env = {
      STEP30_MONGO_URI: mongoUri,
      STEP30_CANDIDATE_ID: `step30-${suffix}`,
      STEP30_ADAPTER_SLUG: `step30-${suffix}`,
    };

    const seeded = runPhase("seed", env);
    assert.equal(seeded.baseline.driftStatus, "NO_ACTION");
    assert.equal(seeded.stable.driftStatus, "NO_ACTION");
    assert.equal(seeded.dashboard.results[0].freshnessStatus, "NO_ACTION");

    const afterRestart = runPhase("verify-baseline", env);
    assert.equal(afterRestart.state.baseline.contentHash, seeded.baseline.urls[0].contentHash);
    assert.equal(afterRestart.state.history.length, 2);
    assert.equal(afterRestart.review, null);
    assert.deepEqual(afterRestart.declaration.urls, [ "https://step30.invalid/bulletin.pdf" ]);
    assert.equal(afterRestart.dashboard.results[0].freshnessStatus, "NO_ACTION");
    assert.deepEqual(afterRestart.writes, []);

    const changed = runPhase("change", env);
    assert.equal(changed.changed.driftStatus, "REVIEW_REQUIRED");
    assert.ok(changed.changed.driftTriggers.includes("content-changed"));

    const afterChangeRestart = runPhase("verify-change", env);
    assert.equal(afterChangeRestart.state.baseline.contentHash, seeded.baseline.urls[0].contentHash);
    assert.equal(afterChangeRestart.state.history.length, 3);
    assert.deepEqual(
      afterChangeRestart.state.history.map((entry) => entry.outcome),
      ["BASELINE", "NO_ACTION", "REVIEW_REQUIRED"]
    );
    assert.equal(afterChangeRestart.review.stage, "REVIEW_REQUIRED");
    assert.deepEqual(afterChangeRestart.declaration.urls, [ "https://step30.invalid/bulletin.pdf" ]);
    assert.equal(afterChangeRestart.dashboard.results[0].freshnessStatus, "REVIEW_REQUIRED");
    assert.deepEqual(afterChangeRestart.writes, []);
  });
});
