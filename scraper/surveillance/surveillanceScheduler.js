// =============================================================================
// scraper/surveillance/surveillanceScheduler.js — scheduler abstraction +
//   STEP 13 deployment-native transport
// =============================================================================
// WHAT: Describes HOW surveillance would be triggered without introducing any
//   scheduler dependency — no cron packages, no Redis/Kafka, no cloud queues.
//   A plan is a validated, bounded list of candidate checks plus the cadence
//   metadata a deployment-native trigger needs. Execution itself stays
//   manual/deterministic via runPlan, which simply delegates to
//   runSurveillanceChecks sequentially.
//   STEP 13 adds the deployment transport: buildCronEntry() emits a validated
//   OS-cron line invoking the existing surveillance CLI, and
//   buildSystemdUnits() emits a .service/.timer pair invoking the same CLI.
//   Both reference the CLI — they never duplicate surveillance logic — and
//   both carry the overlap guard (see operations/runGuard.js): scheduled runs
//   execute through runExclusive(), so a still-running check makes the next
//   tick refuse safely with a SCHEDULER_FAILED notification payload attached.
// WHY: Production scheduling is an infrastructure decision for later. What
//   must be proven now is that a schedule-shaped invocation (bounded set,
//   explicit interval labeling, per-candidate isolation, no overlap) works
//   through the CLI and the plan runner — adopting a real trigger later
//   changes transport, not semantics. Scheduling never publishes anything.
// CONTRACT (STEP 12, unchanged):
//   createSurveillancePlan({ candidateIds?, limit?, maxCandidates?,
//                            intervalMs?, label? })
//     -> { label, intervalMs, maxCandidates, jobs: [{ candidateId }...],
//          createdAt } — pure, validated. Empty/invalid selection throws;
//          over-cap selection throws (narrow explicitly).
//   runPlan(plan, deps, options) -> runSurveillanceChecks over the plan jobs.
//   describePlan(plan) -> human-readable one-liner per job (for CLI output).
// CONTRACT (STEP 13 additions):
//   buildCronEntry({ minute?, hour?, command }) -> { type: "cron", line,
//     command } — validated five-field cron line invoking the CLI.
//   buildSystemdUnits({ name, onCalendar, command, description? })
//     -> { serviceUnit, timerUnit } — unit file texts invoking the CLI.
//   runExclusive({ lockFile?, staleMs?, label? }, fn)
//     -> { ran: true, result } on execution, { ran: false, reason, ownerPid?,
//        notification } when a live lock refuses (the caller emits the
//        SCHEDULER_FAILED payload via notify()). The lock releases in finally
//        (graceful shutdown by construction); stale locks are taken over.
// INTERVALS are labels, not timers: nothing here sleeps, loops, or daemonizes.
// =============================================================================

const { runSurveillanceChecks, DEFAULT_MAX_CANDIDATES } = require("./sourceSurveillance");
const { acquireLock } = require("../operations/runGuard");

const MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function createSurveillancePlan(input = {}) {
  const maxCandidates =
    typeof input.maxCandidates === "number" && input.maxCandidates >= 1
      ? Math.floor(input.maxCandidates)
      : DEFAULT_MAX_CANDIDATES;
  const intervalMs =
    typeof input.intervalMs === "number" && input.intervalMs >= MIN_INTERVAL_MS
      ? Math.floor(input.intervalMs)
      : DEFAULT_INTERVAL_MS;

  let ids;
  if (Array.isArray(input.candidateIds)) {
    const seen = new Set();
    ids = [];
    for (const id of input.candidateIds) {
      if (typeof id !== "string" || !id) {
        throw new Error("surveillanceScheduler: candidate IDs must be non-empty strings");
      }
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    if (ids.length === 0) {
      throw new Error("surveillanceScheduler: empty candidate selection");
    }
    if (ids.length > maxCandidates) {
      throw new Error(
        `surveillanceScheduler: ${ids.length} candidates exceed maxCandidates=${maxCandidates}`
      );
    }
  } else if (typeof input.limit === "number") {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("surveillanceScheduler: limit must be a positive integer");
    }
    ids = null; // resolved at run time against staging (bounded by the runner)
  } else {
    throw new Error("surveillanceScheduler: pass candidateIds or limit");
  }

  return {
    label: typeof input.label === "string" && input.label ? input.label : "manual",
    intervalMs,
    maxCandidates,
    limit: typeof input.limit === "number" ? Math.min(Math.floor(input.limit), maxCandidates) : null,
    jobs: ids === null ? [] : ids.map((candidateId) => ({ candidateId })),
    createdAt: new Date().toISOString(),
  };
}

async function runPlan(plan, deps, options = {}) {
  if (!plan || !Array.isArray(plan.jobs)) {
    throw new Error("surveillanceScheduler: a created plan is required");
  }
  const selection = plan.jobs.length > 0
    ? { candidateIds: plan.jobs.map((job) => job.candidateId) }
    : { limit: plan.limit || plan.maxCandidates };
  return runSurveillanceChecks(selection, deps, {
    ...options,
    maxCandidates: plan.maxCandidates,
  });
}

function describePlan(plan) {
  if (plan.jobs.length > 0) {
    return plan.jobs.map((job) => `check ${job.candidateId} every ${plan.intervalMs}ms [${plan.label}]`);
  }
  return [`check up to ${plan.limit || plan.maxCandidates} candidates every ${plan.intervalMs}ms [${plan.label}]`];
}

// --- STEP 13 deployment-native transport -----------------------------------
// Both builders emit configuration that invokes the EXISTING surveillance CLI
// (scraper/cli/surveillance.js). Bounded execution comes from the CLI's own
// --limit/--max-candidates handling; dry-run stays available via --dry-run.

function cronField(value, fallback, min, max, label) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (text === "*") return text;
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) {
    throw new Error(`surveillanceScheduler: invalid cron ${label} "${value}"`);
  }
  return text;
}

function buildCronEntry(input = {}) {
  if (typeof input.command !== "string" || !input.command.trim()) {
    throw new Error("surveillanceScheduler: a CLI command is required for a cron entry");
  }
  if (!/surveillance\.js/.test(input.command)) {
    throw new Error("surveillanceScheduler: cron must invoke the surveillance CLI (refusing arbitrary commands)");
  }
  const minute = cronField(input.minute, "0", 0, 59, "minute");
  const hour = cronField(input.hour, "2", 0, 23, "hour");
  const line = `${minute} ${hour} * * * ${input.command.trim()}`;
  return { type: "cron", line, command: input.command.trim(), minute, hour };
}

function buildSystemdUnits(input = {}) {
  if (typeof input.name !== "string" || !/^[a-z0-9-]+$/.test(input.name)) {
    throw new Error("surveillanceScheduler: a lowercase unit name is required");
  }
  if (typeof input.onCalendar !== "string" || !input.onCalendar.trim()) {
    throw new Error("surveillanceScheduler: OnCalendar is required (e.g. \"daily\", \"*-*-* 02:00:00\")");
  }
  if (typeof input.command !== "string" || !input.command.trim()) {
    throw new Error("surveillanceScheduler: a CLI command is required for a systemd unit");
  }
  if (!/surveillance\.js/.test(input.command)) {
    throw new Error("surveillanceScheduler: systemd must invoke the surveillance CLI (refusing arbitrary commands)");
  }
  const description = typeof input.description === "string" && input.description
    ? input.description
    : "NextStep source surveillance (dry-run default)";
  const serviceUnit = [
    "[Unit]",
    `Description=${description}`,
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${input.command.trim()}`,
    "",
  ].join("\n");
  const timerUnit = [
    "[Unit]",
    `Description=Run ${input.name} on schedule`,
    "",
    "[Timer]",
    `OnCalendar=${input.onCalendar.trim()}`,
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return { serviceUnit, timerUnit, name: input.name };
}

async function runExclusive(guardOptions = {}, fn) {
  if (typeof fn !== "function") {
    throw new Error("surveillanceScheduler: runExclusive requires a function to guard");
  }
  const guard = acquireLock(guardOptions);
  if (!guard.acquired) {
    // The caller emits this payload with notify() — runExclusive itself
    // sends nothing, keeping scheduling free of notification side effects.
    return {
      ran: false,
      reason: guard.info.reason === "held" ? "another run is active" : "lock unavailable",
      ownerPid: guard.info.ownerPid === undefined ? null : guard.info.ownerPid,
      notification: {
        type: "SCHEDULER_FAILED",
        severity: "warning",
        candidateId: null,
        examName: null,
        message: "scheduled surveillance run refused: another run is active",
        details: { lockFile: guard.info.lockFile || null },
      },
    };
  }
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    guard.release();
  }
}

module.exports = {
  MIN_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  createSurveillancePlan,
  runPlan,
  describePlan,
  buildCronEntry,
  buildSystemdUnits,
  runExclusive,
};
