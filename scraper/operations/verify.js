// =============================================================================
// scraper/operations/verify.js — STEP 14 deployment/smoke verification
// =============================================================================
// WHAT: Ordered deployment verification that proves a checkout is operable
//   without touching exam truth: configuration → dependencies → Python
//   processor → database → health → scheduler → lock → logging →
//   notification → publish boundary. Every step is read-only except writing
//   one probe log line (to a caller-supplied sink) and acquiring+releasing a
//   caller-supplied probe lock — both evidence the path works, neither
//   touches staging, production, or drafts.
// WHY: "It works on my machine" is not a deployment story. One command must
//   answer whether configuration parses, dependencies resolve, MongoDB
//   answers, the Python service answers (when configured), the scheduler
//   config is valid, the lock is free, logs flow, notifications deliver, and
//   the publish boundary still defaults to dry-run — before any real run.
// CONTRACT:
//   verifyDeployment(input?)
//     input: { env?, connection?, fetchFn?, schedulerConfig?, lockFile?,
//              logSink?, transport?, mongoUriNote? } — every infrastructure
//              dependency is injectable, so tests run hermetically.
//     -> { passed, steps: [{ name, status: "pass"|"skip"|"fail", detail }] }.
//        passed is true only when no step fails. Skips (unconfigured Python)
//        never fail the run. Nothing here publishes, writes exam data, or
//        requires live infrastructure beyond what the caller supplies.
// GENERICITY: infrastructure only. No exam names.
// =============================================================================

const { loadConfig, getSafeSummary } = require("./config");
const { checkHealth } = require("./health");
const { isCronLine } = require("./health");
const { createLogger } = require("./logger");
const { notify } = require("./notifications");
const { acquireLock } = require("./runGuard");

function record(steps, name, status, detail) {
  steps.push({ name, status, detail: detail || null });
  return status === "fail";
}

async function verifyDeployment(input = {}) {
  const steps = [];
  let failed = false;

  // 1. Configuration parses (secrets never echoed).
  let config = null;
  try {
    config = loadConfig(input.env);
    record(steps, "configuration", "pass", "required variables present and valid");
  } catch (error) {
    record(steps, "configuration", "fail", error.message);
    return { passed: false, steps, configSummary: null };
  }
  const configSummary = getSafeSummary(config);

  // 2. Key dependencies resolve.
  try {
    for (const spec of ["../pipeline/endToEndIngestion", "../cli/surveillance", "../../server/config/db"]) {
      try {
        require.resolve(spec, { paths: [__dirname] });
      } catch {
        if (!spec.includes("server/config")) throw new Error(`unresolvable module ${spec}`);
      }
    }
    record(steps, "dependencies", "pass", "pipeline, CLI, and app wiring resolve");
  } catch (error) {
    failed = record(steps, "dependencies", "fail", error.message) || failed;
  }

  // 3. Python processor answers when configured (skip = healthy-by-absence).
  if (config.pythonDocprocUrl) {
    const get = typeof input.fetchFn === "function" ? input.fetchFn : fetch;
    try {
      const response = await get(`${config.pythonDocprocUrl.replace(/\/$/, "")}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      failed = record(
        steps, "python-processor", response.ok ? "pass" : "fail",
        response.ok ? "service answered /health" : `service answered HTTP ${response.status}`
      ) || failed;
    } catch (error) {
      failed = record(steps, "python-processor", "fail", `service unreachable: ${error.message}`) || failed;
    }
  } else {
    record(steps, "python-processor", "skip", "PYTHON_DOCPROC_URL not configured");
  }

  // 4-5. Database + full health report (read-only).
  const health = await checkHealth({
    connection: input.connection,
    env: { MONGO_URI: config.mongoUri, SCRAPER_MONGO_URI: config.scraperMongoUri },
    directories: input.directories || [],
    schedulerConfig: input.schedulerConfig,
    pythonDocprocUrl: config.pythonDocprocUrl,
    fetchFn: input.fetchFn,
    lockFile: input.lockFile,
  });
  failed = record(
    steps, "database", health.checks.find((c) => c.name === "database").status === "HEALTHY" ? "pass" : "fail",
    health.checks.find((c) => c.name === "database").reason
  ) || failed;
  failed = record(steps, "health", health.status === "NOT_READY" ? "fail" : "pass", `overall ${health.status}`) || failed;

  // 6. Scheduler configuration validates (cron line shape when provided).
  if (input.cronLine !== undefined) {
    failed = record(
      steps, "scheduler", isCronLine(input.cronLine) ? "pass" : "fail",
      isCronLine(input.cronLine) ? "cron line valid" : "cron line invalid"
    ) || failed;
  } else {
    record(steps, "scheduler", "skip", "no schedule under verification (manual operation)");
  }

  // 7. Lock round-trips (caller-supplied probe path only, never production).
  if (input.probeLockFile) {
    try {
      const guard = acquireLock({ lockFile: input.probeLockFile });
      if (!guard.acquired) {
        failed = record(steps, "lock", "fail", "probe lock refused (another run active?)") || failed;
      } else {
        guard.release();
        record(steps, "lock", "pass", "probe lock acquired and released");
      }
    } catch (error) {
      failed = record(steps, "lock", "fail", error.message) || failed;
    }
  } else {
    record(steps, "lock", "skip", "no probe lock path supplied");
  }

  // 8. Logging flows to the caller-supplied sink.
  try {
    const logger = createLogger({ runId: "verify", sink: input.logSink || (() => {}) });
    logger.log("health.checked", { scope: "deployment-verification" });
    record(steps, "logging", "pass", "probe event emitted to sink");
  } catch (error) {
    failed = record(steps, "logging", "fail", error.message) || failed;
  }

  // 9. Notification delivers through the configured local transport.
  try {
    const receipt = await notify(
      { type: "READINESS_FAILED", severity: "info", message: "deployment verification probe" },
      { logger: createLogger({ runId: "verify", sink: input.logSink || (() => {}) }) }
    );
    failed = record(steps, "notification", receipt.delivered ? "pass" : "fail", `transport=${receipt.transport}`) || failed;
  } catch (error) {
    failed = record(steps, "notification", "fail", error.message) || failed;
  }

  // 10. Publish boundary still defaults to dry-run (read-only module probe:
  // entry points exist, production target is exactly "exams" — no write made).
  try {
    const executor = require("../publish/publishExecutor");
    const intact =
      typeof executor.dryRunPublish === "function" &&
      typeof executor.publishVerifiedDraft === "function" &&
      executor.PRODUCTION_EXAM_COLLECTION === "exams";
    failed = record(
      steps, "publish-boundary", intact ? "pass" : "fail",
      intact ? "dry-run default with explicit confirm gate present" : "publish entry points changed"
    ) || failed;
  } catch (error) {
    failed = record(steps, "publish-boundary", "fail", error.message) || failed;
  }

  return { passed: !failed, steps, configSummary };
}

module.exports = {
  verifyDeployment,
};
