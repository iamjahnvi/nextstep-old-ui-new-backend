// =============================================================================
// scraper/operations/health.js — STEP 13 health and readiness checks
// =============================================================================
// WHAT: Deterministic, read-only health probing for the scraper's operating
//   dependencies: database connectivity, required configuration, required
//   directories, staging access, scheduler configuration, and publish
//   boundary availability. Each check reports HEALTHY | DEGRADED | NOT_READY
//   with a reason; the overall status is the worst of its checks.
// WHY: Operators (and the readiness CLI) need one honest answer — "can this
//   system run?" — plus exactly which dependency says otherwise. A check never
//   publishes, never writes exam data, and never throws an opaque error:
//   unavailable dependencies produce reasons, not stack traces.
// STATES: HEALTHY (all checks pass) · DEGRADED (operable with limits — e.g.
//   no schedule configured, publish boundary unreachable) · NOT_READY (cannot
//   operate — database or configuration or staging access failing).
// CONTRACT:
//   checkHealth({ connection?, env?, directories?, schedulerConfig? })
//     connection: mongoose connection (optional — absent means the database
//       check reports NOT_READY with a reason instead of throwing).
//     env: environment mapping (default process.env) holding MONGO_URI.
//     directories: extra readable paths required (default []).
//     schedulerConfig: { cronLine? } validated when present.
//     -> { status, checks: [{ name, status, reason }] } — no timestamps, so
//        identical inputs decide identically. Read-only: the database check
//        pings and lists collections; nothing is written anywhere.
// GENERICITY: infrastructure only. No exam names, no content.
// =============================================================================

const fs = require("fs");
const { PRODUCTION_EXAM_COLLECTION } = require("../publish/publishExecutor");

const HEALTH_STATES = ["HEALTHY", "DEGRADED", "NOT_READY"];
const STAGING_PREFIX = "scraper_";

function rank(status) {
  return status === "NOT_READY" ? 2 : status === "DEGRADED" ? 1 : 0;
}

function worst(statuses) {
  return statuses.reduce((acc, status) => (rank(status) > rank(acc) ? status : acc), "HEALTHY");
}

function isCronLine(line) {
  if (typeof line !== "string") return false;
  const fields = line.trim().split(/\s+/);
  if (fields.length < 5) return false;
  const [minute, hour, day, month, weekday] = fields;
  const field = (value, min, max) =>
    value === "*" || (/^\d+$/.test(value) && Number(value) >= min && Number(value) <= max);
  return (
    field(minute, 0, 59) &&
    field(hour, 0, 23) &&
    field(day, 1, 31) &&
    field(month, 1, 12) &&
    field(weekday, 0, 7)
  );
}

async function checkDatabase(connection) {
  if (!connection || typeof connection !== "object") {
    return { name: "database", status: "NOT_READY", reason: "no database connection supplied" };
  }
  try {
    if (connection.readyState !== 1) {
      return { name: "database", status: "NOT_READY", reason: `connection state is ${connection.readyState} (expected 1/connected)` };
    }
    await connection.db.admin().ping();
    return { name: "database", status: "HEALTHY", reason: "ping succeeded" };
  } catch (error) {
    return { name: "database", status: "NOT_READY", reason: `ping failed: ${error.message}` };
  }
}

function checkConfig(env) {
  const mapping = env || process.env;
  const uri = mapping && (mapping.MONGO_URI || mapping.SCRAPER_MONGO_URI);
  if (typeof uri !== "string" || !uri) {
    return { name: "config", status: "NOT_READY", reason: "MONGO_URI/SCRAPER_MONGO_URI is not configured" };
  }
  return { name: "config", status: "HEALTHY", reason: "required configuration present" };
}

async function checkDirectories(directories) {
  const list = Array.isArray(directories) ? directories : [];
  const missing = [];
  for (const dir of list) {
    try {
      await fs.promises.access(dir, fs.constants.R_OK);
    } catch {
      missing.push(dir);
    }
  }
  if (missing.length > 0) {
    return { name: "directories", status: "NOT_READY", reason: `unreadable directories: ${missing.join(", ")}` };
  }
  return { name: "directories", status: "HEALTHY", reason: list.length > 0 ? `${list.length} required directories readable` : "no extra directories required" };
}

async function checkStaging(connection) {
  if (!connection || connection.readyState !== 1) {
    return { name: "staging", status: "NOT_READY", reason: "database unavailable for staging check" };
  }
  try {
    const collections = await connection.db.listCollections().toArray();
    const names = collections.map((entry) => entry.name);
    const staging = names.filter((name) => name.startsWith(STAGING_PREFIX));
    if (staging.length === 0) {
      return { name: "staging", status: "DEGRADED", reason: "database reachable but no staging collections exist yet" };
    }
    return { name: "staging", status: "HEALTHY", reason: `${staging.length} staging collections accessible` };
  } catch (error) {
    return { name: "staging", status: "NOT_READY", reason: `staging listing failed: ${error.message}` };
  }
}

function checkScheduler(schedulerConfig) {
  if (!schedulerConfig) {
    return { name: "scheduler", status: "HEALTHY", reason: "manual operation (no schedule required)" };
  }
  if (schedulerConfig.cronLine !== undefined && !isCronLine(schedulerConfig.cronLine)) {
    return { name: "scheduler", status: "DEGRADED", reason: `invalid cron line: ${schedulerConfig.cronLine}` };
  }
  return { name: "scheduler", status: "HEALTHY", reason: "schedule configuration valid" };
}

function checkPublishBoundary() {
  try {
    const executor = require("../publish/publishExecutor");
    if (executor.PRODUCTION_EXAM_COLLECTION !== PRODUCTION_EXAM_COLLECTION || PRODUCTION_EXAM_COLLECTION !== "exams") {
      return { name: "publish-boundary", status: "DEGRADED", reason: "production target mismatch" };
    }
    if (typeof executor.dryRunPublish !== "function" || typeof executor.publishVerifiedDraft !== "function") {
      return { name: "publish-boundary", status: "DEGRADED", reason: "publish entry points unavailable" };
    }
    return { name: "publish-boundary", status: "HEALTHY", reason: "dry-run default with explicit confirm gate present" };
  } catch (error) {
    return { name: "publish-boundary", status: "DEGRADED", reason: `publish boundary unloadable: ${error.message}` };
  }
}

async function checkPythonDocproc(pythonDocprocUrl, fetchFn) {
  if (pythonDocprocUrl === undefined || pythonDocprocUrl === null || pythonDocprocUrl === "") {
    return { name: "python-docproc", status: "HEALTHY", reason: "not configured (HTML-only operation)" };
  }
  const get = typeof fetchFn === "function" ? fetchFn : fetch;
  try {
    const response = await get(`${String(pythonDocprocUrl).replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { name: "python-docproc", status: "DEGRADED", reason: `service answered HTTP ${response.status}` };
    }
    return { name: "python-docproc", status: "HEALTHY", reason: "service answered /health" };
  } catch (error) {
    return { name: "python-docproc", status: "DEGRADED", reason: `service unreachable: ${error.message}` };
  }
}

function checkSchedulerLock(lockFile) {
  if (lockFile === undefined || lockFile === null || lockFile === "") {
    return { name: "scheduler-lock", status: "HEALTHY", reason: "no lock file configured" };
  }
  try {
    const { acquireLock } = require("./runGuard");
    const guard = acquireLock({ lockFile });
    if (guard.acquired) {
      guard.release();
      return { name: "scheduler-lock", status: "HEALTHY", reason: "no overlapping run (probe lock acquired and released)" };
    }
    return { name: "scheduler-lock", status: "DEGRADED", reason: "a surveillance run appears active (lock held)" };
  } catch (error) {
    return { name: "scheduler-lock", status: "DEGRADED", reason: `lock probe failed: ${error.message}` };
  }
}

async function checkHealth(input = {}) {
  const checks = [
    await checkDatabase(input.connection),
    checkConfig(input.env),
    await checkDirectories(input.directories),
    await checkStaging(input.connection),
    checkScheduler(input.schedulerConfig),
    await checkPythonDocproc(input.pythonDocprocUrl, input.fetchFn),
    checkSchedulerLock(input.lockFile),
    checkPublishBoundary(),
  ];
  return { status: worst(checks.map((check) => check.status)), checks };
}

module.exports = {
  HEALTH_STATES,
  isCronLine,
  checkHealth,
  checkPythonDocproc,
  checkSchedulerLock,
};
