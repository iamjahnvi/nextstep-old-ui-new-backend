// =============================================================================
// scraper/tests/deployment.test.js
// =============================================================================
// WHAT: STEP 14 tests — deployment configuration, scheduler templates, file
//   logging, metrics, health additions, notification transports, backup/
//   export/verify, deployment verification, failure handling, and the
//   no-publish/no-accept/no-cloud boundaries.
// WHY: Deployability must be proven hermetically: config fails fast, secrets
//   never leak, schedules stay bounded, metrics observe without deciding, and
//   verification passes without publishing or writing exam data.
// DB: isolated mongodb-memory-server only for metrics/backup reads; health
//   and unit paths use stubs. MONGO_URI unset during the suite.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const mongoose = require("mongoose");
const os = require("os");
const path = require("path");

const { loadConfig, getSafeSummary, REQUIRED_VARS } = require("../operations/config");
const { createFileSink } = require("../operations/logger");
const { createMetrics, collectOperationalMetrics } = require("../operations/metrics");
const { checkHealth, isCronLine } = require("../operations/health");
const {
  resolveTransportConfig,
  createFileTransport,
  createWebhookTransport,
  notify,
} = require("../operations/notifications");
const { backupPlan, exportSnapshot, verifyBackup } = require("../operations/backup");
const { verifyDeployment } = require("../operations/verify");
const { getExamCandidateModel } = require("../models/examCandidate");
const { getSurveillanceStateModel } = require("../models/surveillanceState");
const { getReviewStateModel } = require("../models/reviewState");
const { getOperationRunModel } = require("../models/operationRun");
const { getPublishReceiptModel } = require("../models/publishReceipt");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

const NOW = new Date("2026-09-24T00:00:00Z");

function tempDir(name) {
  const dir = path.join(os.tmpdir(), `nextstep-deploy-test-${name}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stubConnection(collections = [{ name: "scraper_x" }]) {
  return {
    readyState: 1,
    db: {
      admin: () => ({ ping: async () => ({ ok: 1 }) }),
      listCollections: () => ({ toArray: async () => collections }),
    },
  };
}

describe("STEP 14 — deployment configuration", () => {
  it("1. configuration loads, validates, and masks secrets", () => {
    assert.deepEqual(REQUIRED_VARS, ["MONGO_URI"]);
    const config = loadConfig({
      MONGO_URI: "mongodb://user:pass@host/db",
      CRAWLEE_TRANSPORT: "shadow",
      PYTHON_DOCPROC_URL: "http://127.0.0.1:8001",
      NOTIFICATIONS_TRANSPORT: "file",
      NOTIFICATIONS_FILE_DIR: "/tmp/spool",
      OPS_LOG_MAX_BYTES: "1024",
    });
    assert.equal(config.crawleeTransport, "shadow");
    assert.equal(config.dryRun, true);
    assert.equal(config.llm.enabled, false);
    assert.equal(config.ops.logMaxBytes, 1024);
    const summary = getSafeSummary(config);
    assert.equal(summary.mongoUri, "set");
    assert.ok(!JSON.stringify(summary).includes("user:pass"));
    assert.throws(() => loadConfig({}), /MONGO_URI is required/);
    assert.throws(() => loadConfig({ MONGO_URI: "mongodb://host/db", CRAWLEE_TRANSPORT: "turbo" }), /CRAWLEE_TRANSPORT/);
    assert.throws(() => loadConfig({ MONGO_URI: "mongodb://host/db", PYTHON_DOCPROC_URL: "ftp://x" }), /http\(s\)/);
    assert.throws(() => loadConfig({ MONGO_URI: "mongodb://host/db", OPS_LOG_MAX_BYTES: "huge" }), /positive integer/);
    assert.throws(() => loadConfig({ MONGO_URI: "mongodb://host/db", NOTIFICATIONS_TRANSPORT: "sms" }), /log\|file\|webhook/);
    const example = fs.readFileSync(path.join(__dirname, "..", "..", ".env.example"), "utf8");
    assert.ok(example.includes("MONGO_URI="));
    assert.ok(example.includes("CRAWLEE_TRANSPORT=off"));
    assert.ok(example.includes("LLM_SEMANTIC_EXTRACTION=false"));
  });

  it("2. scheduler templates are valid and bounded", () => {
    const cronText = fs.readFileSync(path.join(__dirname, "..", "operations", "deploy", "nextstep-surveillance.cron"), "utf8");
    const line = cronText.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    assert.ok(isCronLine(line.split(/\s+/).slice(0, 5).join(" ")));
    assert.ok(line.includes("surveillance.js --limit 5"));
    const service = fs.readFileSync(path.join(__dirname, "..", "operations", "deploy", "nextstep-surveillance.service"), "utf8");
    assert.ok(service.includes("Type=oneshot") && service.includes("ExecStart=") && service.includes("surveillance.js"));
    const timer = fs.readFileSync(path.join(__dirname, "..", "operations", "deploy", "nextstep-surveillance.timer"), "utf8");
    assert.ok(timer.includes("OnCalendar=") && timer.includes("WantedBy=timers.target"));
  });
});

describe("STEP 14 — logging, metrics, health additions", () => {
  it("3. file sink appends JSON lines and rotates", () => {
    const dir = tempDir("logs");
    const file = path.join(dir, "ops.jsonl");
    const sink = createFileSink({ filePath: file, maxBytes: 40 });
    sink({ event: "a", n: 1 });
    sink({ event: "b", n: 2 });
    sink({ event: "c", n: 3 });
    assert.ok(fs.existsSync(`${file}.1`), "rotation keeps one backup");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.ok(lines.every((l) => JSON.parse(l)));
    assert.throws(() => createFileSink({}), /filePath is required/);
  });

  it("4. metrics count, time, and snapshot deterministically", () => {
    const metrics = createMetrics();
    metrics.inc("ingestion.runs");
    metrics.inc("ingestion.runs");
    metrics.inc("ingestion.failed", { stage: "FETCH" });
    metrics.observeDuration("operation.duration", null, 100);
    metrics.observeDuration("operation.duration", null, 300);
    const snap = metrics.snapshot();
    assert.equal(snap.counters["ingestion.runs"], 2);
    assert.equal(snap.counters["ingestion.failed|stage=FETCH"], 1);
    assert.deepEqual(snap.durations["operation.duration"], { count: 2, totalMs: 400, avgMs: 200 });
    assert.deepEqual(metrics.snapshot(), snap);
    metrics.reset();
    assert.deepEqual(metrics.snapshot(), { counters: {}, durations: {} });
    assert.throws(() => metrics.inc(""), /counter name is required/);
  });

  it("5. python and lock health checks degrade honestly", async () => {
    const base = { connection: stubConnection(), env: { MONGO_URI: "mongodb://host/db" }, directories: [] };
    const unconfigured = await checkHealth(base);
    assert.ok(unconfigured.checks.some((c) => c.name === "python-docproc" && c.status === "HEALTHY"));
    const up = await checkHealth({
      ...base,
      pythonDocprocUrl: "http://127.0.0.1:9",
      fetchFn: async () => ({ ok: true }),
    });
    assert.ok(up.checks.some((c) => c.name === "python-docproc" && c.status === "HEALTHY"));
    const down = await checkHealth({
      ...base,
      pythonDocprocUrl: "http://127.0.0.1:9",
      fetchFn: async () => ({ ok: false, status: 500 }),
    });
    assert.equal(down.status, "DEGRADED");
    const refused = await checkHealth({
      ...base,
      pythonDocprocUrl: "http://127.0.0.1:9",
      fetchFn: async () => { throw new Error("refused"); },
    });
    assert.ok(refused.checks.some((c) => c.name === "python-docproc" && c.status === "DEGRADED"));
    const lockFile = path.join(tempDir("locks"), "probe.lock");
    const free = await checkHealth({ ...base, lockFile });
    assert.ok(free.checks.some((c) => c.name === "scheduler-lock" && c.status === "HEALTHY"));
    assert.ok(!fs.existsSync(lockFile), "probe lock cleans up");
  });
});

describe("STEP 14 — notification transports", () => {
  it("6. file transport spools parseable JSON (redaction happens in notify)", async () => {
    const dir = tempDir("spool");
    const transport = createFileTransport({ dir });
    const receipt = await transport.send({ type: "REVIEW_REQUIRED", at: "t" });
    assert.equal(receipt.delivered, true);
    assert.equal(receipt.transport, "file");
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8")).type, "REVIEW_REQUIRED");
    // End to end: notify() redacts before the file transport ever sees secrets.
    await notify(
      { type: "REVIEW_REQUIRED", severity: "info", message: "m", details: { password: "x" } },
      { transport: createFileTransport({ dir }) }
    );
    const bodies = fs.readdirSync(dir).map((file) => fs.readFileSync(path.join(dir, file), "utf8"));
    assert.ok(!bodies.some((body) => body.includes('"password": "x"')));
    assert.throws(() => createFileTransport({}), /requires a dir/);
  });

  it("7. webhook transport posts redacted payloads", async () => {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        received.push({ url: req.url, body: JSON.parse(body) });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const transport = createWebhookTransport({ url: `http://127.0.0.1:${server.address().port}/hook` });
      const out = await notify(
        { type: "SURVEILLANCE_FAILED", severity: "critical", message: "down", details: { token: "abc" } },
        { transport }
      );
      assert.equal(out.delivered, true);
      assert.equal(out.transport, "webhook");
      assert.equal(received.length, 1);
      assert.equal(received[0].body.details.token, "[REDACTED]");
      assert.throws(() => createWebhookTransport({}), /requires a url/);
      assert.throws(() => createWebhookTransport({ url: "ftp://x" }), /http\(s\)/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("8. transport config enables delivery safely", () => {
    assert.deepEqual(resolveTransportConfig({}), { enabled: false, transport: "log", fileDir: null, webhookUrl: null });
    const on = resolveTransportConfig({ NOTIFICATIONS_ENABLED: "true", NOTIFICATIONS_TRANSPORT: "webhook", NOTIFICATIONS_WEBHOOK_URL: "https://hooks.example/hook" });
    assert.equal(on.enabled, true);
    assert.throws(() => resolveTransportConfig({ NOTIFICATIONS_TRANSPORT: "webhook" }), /NOTIFICATIONS_WEBHOOK_URL/);
    assert.throws(() => resolveTransportConfig({ NOTIFICATIONS_TRANSPORT: "pager" }), /log\|file\|webhook/);
  });
});

describe("STEP 14 — backup, metrics rollup, verification", () => {
  let mongod;
  let mongoUri;
  let connection;
  let models;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("step14_deploy"));
    connection = await mongoose.createConnection(mongoUri).asPromise();
    models = {
      ExamCandidate: getExamCandidateModel(connection),
      SurveillanceState: getSurveillanceStateModel(connection),
      ReviewState: getReviewStateModel(connection),
      OperationRun: getOperationRunModel(connection),
      Receipt: getPublishReceiptModel(connection),
    };
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
  });

  it("9. export snapshots verify round-trip", async () => {
    for (const model of Object.values(models)) await model.deleteMany({});
    await models.ExamCandidate.create({
      candidateId: "dsc-backup-1", name: "Backup One", sourceUrl: "http://127.0.0.1/",
      sourceDomain: "127.0.0.1", discoverySource: "s", discoveredAt: NOW, status: "DISCOVERED", evidence: [],
    });
    const dir = tempDir("backup");
    const plan = backupPlan(["scraper_exam_candidates"]);
    assert.ok(plan.collections.includes("scraper_exam_candidates"));
    assert.throws(() => backupPlan([]), /at least one collection/);
    const exported = await exportSnapshot({ connection, collections: ["scraper_exam_candidates"], dir });
    assert.equal(exported.files[0].documents, 1);
    const verified = verifyBackup(dir, ["scraper_exam_candidates"]);
    assert.equal(verified.ok, true);
    fs.writeFileSync(path.join(dir, "scraper_exam_candidates.json"), "not json{{{");
    assert.equal(verifyBackup(dir, ["scraper_exam_candidates"]).ok, false);
    await assert.rejects(exportSnapshot({ dir }), /database connection is required/);
  });

  it("10. operational metrics roll up read-only staging", async () => {
    for (const model of Object.values(models)) await model.deleteMany({});
    await models.OperationRun.create({ runId: "r1", runType: "surveillance", startedAt: NOW, finishedAt: NOW, status: "COMPLETED" });
    await models.OperationRun.create({ runId: "r2", runType: "ingestion", startedAt: NOW, finishedAt: NOW, status: "FAILED" });
    await models.ReviewState.create({ draftId: "d1", stage: "REVIEW_REQUIRED", items: [], decidedAt: NOW, history: [] });
    await models.SurveillanceState.create({ candidateId: "dsc-1", sourceUrl: "http://127.0.0.1/", history: [], lastOutcome: "NO_ACTION" });
    await models.Receipt.create({
      identity: "x:2026:2026", draftId: new mongoose.Types.ObjectId(), examSlug: "x", year: 2026,
      cycle: "2026", examId: new mongoose.Types.ObjectId(), publishedAt: NOW,
    });
    const metrics = await collectOperationalMetrics(models);
    assert.deepEqual(metrics.runs, { completed: 1, failed: 1, partial: 0, running: 0, total: 2 });
    assert.deepEqual(metrics.review, { reviewRequired: 1, readyForReview: 0 });
    assert.deepEqual(metrics.surveillance, { reviewRequired: 0, noAction: 1 });
    assert.equal(metrics.publish.attempts, 1);
    assert.deepEqual(await collectOperationalMetrics({}), {
      runs: { completed: 0, failed: 0, partial: 0, running: 0, total: 0 },
      review: { reviewRequired: 0, readyForReview: 0 },
      surveillance: { reviewRequired: 0, noAction: 0 },
      publish: { attempts: 0 },
    });
  });

  it("11. deployment verification passes hermetically without side effects", async () => {
    const events = [];
    const lockFile = path.join(tempDir("verifylock"), "probe.lock");
    const before = await models.ExamCandidate.countDocuments({});
    const result = await verifyDeployment({
      env: { MONGO_URI: "mongodb://host/db" },
      connection: stubConnection(),
      fetchFn: async () => ({ ok: true }),
      schedulerConfig: null,
      cronLine: "0 2 * * * node scraper/cli/surveillance.js --limit 5 --persist",
      lockFile,
      probeLockFile: lockFile,
      logSink: (record) => events.push(record),
    });
    assert.equal(result.passed, true);
    assert.ok(result.steps.every((step) => step.status !== "fail"));
    assert.ok(result.steps.some((step) => step.name === "publish-boundary" && step.status === "pass"));
    assert.ok(events.length > 0);
    assert.equal(await models.ExamCandidate.countDocuments({}), before);
    assert.ok(!fs.existsSync(lockFile), "probe lock released");
    assert.equal(result.configSummary.mongoUri, "set");
  });

  it("12. verification reports failures honestly", async () => {
    const missing = await verifyDeployment({ env: {} });
    assert.equal(missing.passed, false);
    assert.ok(missing.steps.some((step) => step.name === "configuration" && step.status === "fail"));
    const badSchedule = await verifyDeployment({
      env: { MONGO_URI: "mongodb://host/db" },
      connection: stubConnection(),
      cronLine: "whenever",
      logSink: () => {},
    });
    assert.equal(badSchedule.passed, false);
    const pythonDown = await verifyDeployment({
      env: { MONGO_URI: "mongodb://host/db", PYTHON_DOCPROC_URL: "http://127.0.0.1:9" },
      connection: stubConnection(),
      fetchFn: async () => { throw new Error("refused"); },
      logSink: () => {},
    });
    assert.ok(pythonDown.steps.some((step) => step.name === "python-processor" && step.status === "fail"));
  });
});

describe("STEP 14 — boundaries", () => {
  it("13. deployment layer publishes nothing, accepts nothing, needs no cloud", () => {
    for (const relative of [
      "operations/config.js",
      "operations/logger.js",
      "operations/metrics.js",
      "operations/backup.js",
      "operations/verify.js",
      "operations/notifications.js",
    ]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      // Only a read-only reference to the executor module is tolerated (the
      // publish-boundary availability probe) — never service/validator/mapper,
      // never a call.
      const publishRequires = [...code.matchAll(/require\(["']([^"']+)["']\)/g)]
        .map((match) => match[1])
        .filter((spec) => spec.includes("publish"));
      assert.ok(
        publishRequires.every((spec) => spec.endsWith("publish/publishExecutor")),
        `${relative}: unexpected publish imports: ${publishRequires.join(", ")}`
      );
      assert.ok(!/dryRunPublish\s*\(|publishVerifiedDraft\s*\(|confirmPublish/.test(code.replace(/\/\/.*$/gm, "")), `${relative}: no publish calls`);
      assert.ok(!/autoPublish|autoAccept|autoApprove/i.test(code.replace(/\/\/.*$/gm, "")), `${relative}: no auto-acceptance`);
      assert.ok(!/redis|kafka|bullmq|aws-sdk|@google-cloud|azure/i.test(code), `${relative}: no cloud/queue dependencies`);
      const executable = code
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
        .replace(/\/\/.*$/gm, "");
      assert.ok(!/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable), `${relative}: no exam names`);
    }
  });
});
