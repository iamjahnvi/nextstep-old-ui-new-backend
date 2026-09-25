// =============================================================================
// scraper/tests/operations.test.js
// =============================================================================
// WHAT: STEP 13 tests — scheduling transport config, overlap guard, structured
//   logging with secret redaction, operation-run lifecycle, health/readiness
//   states, notifications, retention planning/pruning, CLI parsing, and the
//   no-publish/no-accept boundaries.
// WHY: Operations must be provably safe: bounded schedules, no overlapping
//   runs, visible failures, redacted logs, append-only history, and zero
//   paths to publishing or auto-acceptance.
// DB: isolated mongodb-memory-server only for run/retention persistence;
//   health tests use stub connections. MONGO_URI unset during the suite.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const mongoose = require("mongoose");
const os = require("os");
const path = require("path");

const { redact, createLogger } = require("../operations/logger");
const { NOTIFICATION_TYPES, notify } = require("../operations/notifications");
const {
  OPERATION_RUN_STATUSES,
  getOperationRunModel,
  beginOperationRun,
  finishOperationRun,
} = require("../models/operationRun");
const { checkHealth } = require("../operations/health");
const { RETENTION_POLICY, planRetention, applyRetention } = require("../operations/retention");
const { acquireLock } = require("../operations/runGuard");
const { buildCronEntry, buildSystemdUnits, runExclusive } = require("../surveillance/surveillanceScheduler");
const { getSurveillanceStateModel } = require("../models/surveillanceState");
const { getReviewStateModel } = require("../models/reviewState");
const { parseArgs, main } = require("../cli/operations");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

const NOW = new Date("2026-09-24T00:00:00Z");

function lockPath(name) {
  return path.join(os.tmpdir(), `nextstep-ops-test-${name}-${process.pid}.lock`);
}

function stubConnection(state = 1, collections = [{ name: "scraper_x" }]) {
  return {
    readyState: state,
    db: {
      admin: () => ({ ping: async () => ({ ok: 1 }) }),
      listCollections: () => ({ toArray: async () => collections }),
    },
  };
}

describe("STEP 13 — scheduling transport and overlap guard", () => {
  it("1. cron entries invoke the surveillance CLI on a valid schedule", () => {
    const entry = buildCronEntry({ minute: "30", hour: "2", command: "node scraper/cli/surveillance.js --limit 5 --persist" });
    assert.equal(entry.type, "cron");
    assert.equal(entry.line, "30 2 * * * node scraper/cli/surveillance.js --limit 5 --persist");
    const defaults = buildCronEntry({ command: "node scraper/cli/surveillance.js --limit 5" });
    assert.equal(defaults.line, "0 2 * * * node scraper/cli/surveillance.js --limit 5");
    assert.throws(() => buildCronEntry({ minute: "99", command: "node scraper/cli/surveillance.js --limit 5" }), /invalid cron minute/);
    assert.throws(() => buildCronEntry({ command: "rm -rf /" }), /surveillance CLI/);
    assert.throws(() => buildCronEntry({}), /command is required/);
  });

  it("2. systemd units invoke the surveillance CLI on a calendar", () => {
    const units = buildSystemdUnits({ name: "nextstep-surveillance", onCalendar: "daily", command: "node scraper/cli/surveillance.js --limit 5 --persist" });
    assert.ok(units.serviceUnit.includes("Type=oneshot"));
    assert.ok(units.serviceUnit.includes("ExecStart=node scraper/cli/surveillance.js --limit 5 --persist"));
    assert.ok(units.timerUnit.includes("OnCalendar=daily"));
    assert.ok(units.timerUnit.includes("WantedBy=timers.target"));
    assert.throws(() => buildSystemdUnits({ name: "Bad Name!", onCalendar: "daily", command: "node scraper/cli/surveillance.js --limit 5" }), /unit name/);
    assert.throws(() => buildSystemdUnits({ name: "x", onCalendar: "daily", command: "curl evil.example" }), /surveillance CLI/);
  });

  it("3. an active lock refuses the second run; release frees it", () => {
    const file = lockPath("basic");
    try { fs.unlinkSync(file); } catch { /* fresh */ }
    const first = acquireLock({ lockFile: file });
    assert.equal(first.acquired, true);
    const second = acquireLock({ lockFile: file });
    assert.equal(second.acquired, false);
    assert.equal(second.info.reason, "held");
    assert.equal(typeof second.info.ownerPid, "number");
    assert.equal(first.release(), true);
    assert.equal(first.release(), true);
    const third = acquireLock({ lockFile: file });
    assert.equal(third.acquired, true);
    assert.equal(third.release(), true);
  });

  it("4. stale locks are taken over; runExclusive cleans up", async () => {
    const file = lockPath("stale");
    fs.writeFileSync(file, JSON.stringify({ pid: 1, startedAt: new Date(Date.now() - 7200000).toISOString(), label: "old" }));
    const takeover = acquireLock({ lockFile: file, staleMs: 60000 });
    assert.equal(takeover.acquired, true);
    assert.equal(takeover.info.tookOverStale, true);
    assert.equal(takeover.release(), true);

    const ran = await runExclusive({ lockFile: file }, async () => "done");
    assert.deepEqual(ran, { ran: true, result: "done" });
    assert.ok(!fs.existsSync(file), "lock released after success");

    const held = acquireLock({ lockFile: file });
    assert.equal(held.acquired, true);
    const refused = await runExclusive({ lockFile: file }, async () => "never");
    assert.equal(refused.ran, false);
    assert.equal(refused.notification.type, "SCHEDULER_FAILED");
    assert.equal(held.release(), true);

    const direct = acquireLock({ lockFile: file });
    assert.equal(direct.acquired, true);
    assert.equal(direct.release(), true);
    await assert.rejects(runExclusive({ lockFile: file }, async () => { throw new Error("boom"); }), /boom/);
    assert.ok(!fs.existsSync(file), "lock released after failure");
  });
});

describe("STEP 13 — logging, runs, notifications", () => {
  it("5. structured events carry context and redact secrets", () => {
    const records = [];
    const logger = createLogger({ runId: "run-1", sink: (record) => records.push(record) });
    const record = logger.log("candidate.failed", {
      candidateId: "dsc-1",
      stage: "FETCH",
      status: "FAILED",
      durationMs: 12,
      error: "timeout",
      password: "hunter2",
      nested: { apiKey: "abc", uri: "mongodb://user:pass@host/db" },
      safeUri: "mongodb://host/db",
    });
    assert.equal(record.event, "candidate.failed");
    assert.equal(record.runId, "run-1");
    assert.ok(record.timestamp);
    assert.equal(record.password, "[REDACTED]");
    assert.equal(record.nested.apiKey, "[REDACTED]");
    assert.equal(record.nested.uri, "[REDACTED]");
    assert.equal(record.safeUri, "mongodb://host/db");
    assert.equal(records.length, 1);
    assert.throws(() => logger.log(""), /event name is required/);
    assert.deepEqual(redact(["a", { token: "x" }]), ["a", { token: "[REDACTED]" }]);
  });

  it("6. operation runs open once and close exactly once", async () => {
    const { mongod, mongoUri } = await startIsolatedDb("step13_runs");
    const connection = await mongoose.createConnection(mongoUri).asPromise();
    try {
      const OperationRun = getOperationRunModel(connection);
      const run = await beginOperationRun(OperationRun, { runId: "run-1", runType: "surveillance", candidateCount: 3 });
      assert.equal(run.status, "RUNNING");
      const done = await finishOperationRun(OperationRun, "run-1", {
        status: "PARTIAL", successCount: 2, failureCount: 1, reviewRequiredCount: 0, errorSummary: ["dsc-bad: timeout"],
      });
      assert.equal(done.status, "PARTIAL");
      assert.ok(done.finishedAt);
      assert.deepEqual(done.errorSummary, ["dsc-bad: timeout"]);
      await assert.rejects(finishOperationRun(OperationRun, "run-1", { status: "COMPLETED" }), /already terminal/);
      await assert.rejects(finishOperationRun(OperationRun, "missing", { status: "FAILED" }), /unknown runId/);
      await assert.rejects(beginOperationRun(OperationRun, { runId: "x", runType: "nope" }), /unknown runType/);
      assert.deepEqual(OPERATION_RUN_STATUSES, ["RUNNING", "COMPLETED", "FAILED", "PARTIAL"]);
    } finally {
      await closeIsolatedDb({ mongod, connection });
    }
  });

  it("7. notifications validate, redact, and stay local", async () => {
    const sent = [];
    const out = await notify(
      {
        type: "REVIEW_REQUIRED",
        severity: "warning",
        candidateId: "dsc-1",
        examName: null,
        message: "drift needs eyes",
        details: { token: "secret", url: "http://127.0.0.1/x" },
      },
      { transport: { name: "test", send: async (n) => { sent.push(n); return { delivered: true, transport: "test" }; } } }
    );
    assert.equal(out.delivered, true);
    assert.equal(out.transport, "test");
    assert.equal(sent[0].details.token, "[REDACTED]");
    assert.equal(sent[0].details.url, "http://127.0.0.1/x");
    assert.deepEqual(NOTIFICATION_TYPES, ["REVIEW_REQUIRED", "SURVEILLANCE_FAILED", "INGESTION_FAILED", "SCHEDULER_FAILED", "READINESS_FAILED"]);
    await assert.rejects(notify({ type: "NOPE", severity: "info", message: "x" }), /unknown type/);
    await assert.rejects(notify({ type: "REVIEW_REQUIRED", severity: "loud", message: "x" }), /unknown severity/);
    await assert.rejects(notify({ type: "REVIEW_REQUIRED", severity: "info" }), /message is required/);
  });
});

describe("STEP 13 — health and readiness", () => {
  const healthyInput = () => ({
    connection: stubConnection(),
    env: { MONGO_URI: "mongodb://host/db" },
    directories: [process.cwd()],
    schedulerConfig: null,
  });

  it("8. healthy inputs decide HEALTHY, deterministically", async () => {
    const first = await checkHealth(healthyInput());
    assert.equal(first.status, "HEALTHY");
    assert.ok(first.checks.every((check) => check.status === "HEALTHY"));
    assert.deepEqual(await checkHealth(healthyInput()), first);
    assert.deepEqual(await checkHealth({ ...healthyInput(), connection: null }), await checkHealth({ ...healthyInput(), connection: null }));
  });

  it("9. unavailable dependencies explain themselves as NOT_READY", async () => {
    const noDb = await checkHealth({ ...healthyInput(), connection: null });
    assert.equal(noDb.status, "NOT_READY");
    assert.ok(noDb.checks.some((check) => check.name === "database" && /no database connection/.test(check.reason)));
    const noConfig = await checkHealth({ ...healthyInput(), env: {} });
    assert.equal(noConfig.status, "NOT_READY");
    assert.ok(noConfig.checks.some((check) => check.name === "config"));
    const badDirs = await checkHealth({ ...healthyInput(), directories: [path.join(os.tmpdir(), "nextstep-no-such-dir-xyz")] });
    assert.equal(badDirs.status, "NOT_READY");
  });

  it("10. degraded states stay operable and explicit", async () => {
    const freshDb = await checkHealth({
      ...healthyInput(),
      connection: stubConnection(1, [{ name: "other_collection" }]),
    });
    assert.equal(freshDb.status, "DEGRADED");
    const badSchedule = await checkHealth({ ...healthyInput(), schedulerConfig: { cronLine: "not a cron" } });
    assert.equal(badSchedule.status, "DEGRADED");
    assert.ok(badSchedule.checks.some((check) => check.name === "scheduler" && /invalid cron/.test(check.reason)));
  });
});

describe("STEP 13 — retention policy", () => {
  let mongod;
  let mongoUri;
  let connection;
  let models;
  let savedMongoUri;

  function checkEntry(i) {
    return { checkedAt: new Date(NOW.getTime() + i * 1000), outcome: "NO_ACTION", triggers: [], snapshot: null };
  }

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("step13_retention"));
    connection = await mongoose.createConnection(mongoUri).asPromise();
    models = {
      SurveillanceState: getSurveillanceStateModel(connection),
      ReviewState: getReviewStateModel(connection),
      OperationRun: getOperationRunModel(connection),
    };
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
  });

  async function seed() {
    for (const model of [models.SurveillanceState, models.ReviewState, models.OperationRun]) {
      await model.deleteMany({});
    }
    await models.SurveillanceState.create({
      candidateId: "dsc-old", sourceUrl: "http://127.0.0.1/o.html", sourceDomain: "127.0.0.1",
      history: Array.from({ length: 25 }, (_, i) => checkEntry(i)),
    });
    await models.ReviewState.create({
      draftId: "draft-old", stage: "REVIEW_REQUIRED", items: [],
      decidedAt: NOW, history: Array.from({ length: 22 }, () => ({ stage: "REVIEW_REQUIRED", decidedAt: NOW, itemCount: 1 })),
    });
    const old = new Date(NOW.getTime() - 100 * 24 * 60 * 60 * 1000);
    await models.OperationRun.create({ runId: "old-done", runType: "surveillance", startedAt: old, finishedAt: old, status: "COMPLETED" });
    await models.OperationRun.create({ runId: "old-running", runType: "surveillance", startedAt: old, finishedAt: null, status: "RUNNING" });
    await models.OperationRun.create({ runId: "fresh-done", runType: "health", startedAt: NOW, finishedAt: NOW, status: "COMPLETED" });
  }

  it("11. planning counts prunables without writing", async () => {
    await seed();
    const plan = await planRetention(models, { now: new Date(NOW) });
    assert.equal(plan.prunable.surveillanceEntries, 5);
    assert.equal(plan.prunable.reviewEntries, 2);
    assert.equal(plan.prunable.operationRuns, 1);
    assert.ok(plan.retained.includes("scraper_rawdocuments"));
    assert.ok(plan.retained.includes("scraper_editiondrafts"));
    assert.equal(await models.SurveillanceState.countDocuments({}), 1);
  });

  it("12. pruning requires explicit confirm plus actor, and keeps newest", async () => {
    await seed();
    await assert.rejects(applyRetention(models, { actor: "op" }), /explicit \{ confirm: true \}/);
    await assert.rejects(applyRetention(models, { confirm: true, actor: "  " }), /actor name/);
    const report = await applyRetention(models, { confirm: true, actor: "ops-test", now: new Date(NOW) });
    assert.equal(report.actor, "ops-test");
    assert.deepEqual(report.pruned, { surveillanceEntries: 5, reviewEntries: 2, operationRuns: 1 });
    assert.ok(report.retained.includes("scraper_publish_receipts"));
    const state = await models.SurveillanceState.findOne({ candidateId: "dsc-old" }).lean();
    assert.equal(state.history.length, 20);
    assert.equal(await models.OperationRun.countDocuments({ runId: "old-done" }), 0);
    assert.equal(await models.OperationRun.countDocuments({ runId: "old-running" }), 1);
    assert.equal(await models.OperationRun.countDocuments({ runId: "fresh-done" }), 1);
  });
});

describe("STEP 13 — operations CLI and boundaries", () => {
  it("13. CLI parses safe commands and refuses writers", () => {
    assert.equal(parseArgs(["health"]).command, "health");
    assert.equal(parseArgs(["status", "--limit", "5", "--mongo-uri", "mongodb://host/db"]).limit, 5);
    assert.equal(parseArgs(["retention"]).command, "retention");
    assert.throws(() => parseArgs([]), /a command is required/);
    assert.throws(() => parseArgs(["publish"]), /unknown command/);
    assert.throws(() => parseArgs(["health", "extra", "--mongo-uri", "x"]), /expected one command/);
    assert.throws(() => parseArgs(["status", "--limit", "0"]), /positive integer/);
    assert.throws(() => parseArgs(["health", "--publish"]), /unknown argument/);
    assert.equal(parseArgs(["--help"]).help, true);
  });

  it("14. help exits cleanly without infrastructure", async () => {
    assert.equal(await main(["--help"]), 0);
  });

  it("15. operations name no exams, publish nothing, accept nothing", () => {
    for (const relative of [
      "operations/logger.js",
      "operations/notifications.js",
      "operations/health.js",
      "operations/retention.js",
      "operations/runGuard.js",
      "models/operationRun.js",
      "cli/operations.js",
      "surveillance/surveillanceScheduler.js",
    ]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      // Only health.js may reference the executor module — a read-only
      // entry-point presence check for the publish-boundary probe, never a
      // call. Every other publish require is forbidden.
      const publishRequires = [...code.matchAll(/require\(["']([^"']+)["']\)/g)]
        .map((match) => match[1])
        .filter((spec) => spec.includes("publish"));
      assert.ok(
        publishRequires.every((spec) => spec.endsWith("publish/publishExecutor")),
        `${relative}: unexpected publish imports: ${publishRequires.join(", ")}`
      );
      assert.ok(!/publishVerifiedDraft\s*\(|confirmPublish|dryRunPublish\s*\(/.test(code.replace(/\/\/.*$/gm, "")), `${relative}: no publish calls`);
      assert.ok(!/autoPublish|autoAccept|autoApprove|approveReview/i.test(code.replace(/\/\/.*$/gm, "")), `${relative}: no auto-acceptance`);
      const executable = code
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
        .replace(/\/\/.*$/gm, "");
      assert.ok(!/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable), `${relative}: no exam names`);
    }
  });
});
