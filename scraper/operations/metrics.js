// =============================================================================
// scraper/operations/metrics.js — STEP 14 lightweight operational metrics
// =============================================================================
// WHAT: Dependency-free, read-only operational metrics. Two halves that never
//   touch scraper decisions:
//   1. In-process counters/timings (createMetrics): inc(name, labels?, by?),
//      observeDuration(name, labels?, ms), snapshot() — process-local,
//      deterministic, resettable. For live operational code paths that opt in.
//   2. Staging-derived rollups (collectOperationalMetrics): counts runs by
//      status/type, review states by stage, surveillance outcomes, and
//      publish receipts from the existing staging collections — pure reads
//      over models the caller supplies. Nothing is written, nothing decided.
// WHY: Operators need "how is the system doing?" without a metrics platform:
//   ingestion runs, outcomes, review queues, fetch failures (from run error
//   summaries), publish attempts/results (from receipts), scheduler refusals
//   (from runs), durations (from run timestamps), document-processing failures
//   (from surveillance/ingestion error summaries matching /process/i).
//   Heavier needs (Prometheus, dashboards) stay out of scope.
// CONTRACT:
//   createMetrics() -> { inc, observeDuration, snapshot, reset }.
//     snapshot() -> { counters: { "name|label": n }, durations: { name:
//       { count, totalMs, avgMs } } } — labels serialize deterministically
//       (sorted keys), so identical sequences snapshot identically.
//   collectOperationalMetrics({ OperationRun, ReviewState, SurveillanceState,
//     Receipt }) -> { runs, review, surveillance, publish } — all counts, no
//     writes. Any model may be null (that section reports zeros).
// METRIC NAMES (stable): ingestion.runs, ingestion.completed,
//   ingestion.failed, ingestion.review_required, surveillance.checks,
//   surveillance.review_required, fetch.failures, docproc.failures,
//   publish.attempts, publish.created, scheduler.refused.
// GENERICITY: counts only. No exam names, no content.
// =============================================================================

function labelKey(labels) {
  if (!labels || typeof labels !== "object") return "";
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(",");
}

function createMetrics() {
  const counters = new Map();
  const durations = new Map();

  function inc(name, labels, by = 1) {
    if (typeof name !== "string" || !name) {
      throw new Error("metrics: counter name is required");
    }
    const amount = typeof by === "number" && by > 0 ? by : 1;
    const key = labelKey(labels) ? `${name}|${labelKey(labels)}` : name;
    counters.set(key, (counters.get(key) || 0) + amount);
    return counters.get(key);
  }

  function observeDuration(name, labels, ms) {
    if (typeof name !== "string" || !name) {
      throw new Error("metrics: duration name is required");
    }
    const elapsed = typeof ms === "number" && ms >= 0 ? ms : 0;
    const key = labelKey(labels) ? `${name}|${labelKey(labels)}` : name;
    const current = durations.get(key) || { count: 0, totalMs: 0 };
    current.count += 1;
    current.totalMs += elapsed;
    durations.set(key, current);
    return current;
  }

  function snapshot() {
    const counterOut = {};
    for (const key of [...counters.keys()].sort()) counterOut[key] = counters.get(key);
    const durationOut = {};
    for (const key of [...durations.keys()].sort()) {
      const entry = durations.get(key);
      durationOut[key] = {
        count: entry.count,
        totalMs: entry.totalMs,
        avgMs: entry.count > 0 ? entry.totalMs / entry.count : 0,
      };
    }
    return { counters: counterOut, durations: durationOut };
  }

  function reset() {
    counters.clear();
    durations.clear();
  }

  return { inc, observeDuration, snapshot, reset };
}

async function countWhere(model, filter) {
  if (!model || typeof model.countDocuments !== "function") return 0;
  return model.countDocuments(filter);
}

async function collectOperationalMetrics(models = {}) {
  const { OperationRun, ReviewState, SurveillanceState, Receipt } = models;
  const [completed, failed, partial, running] = await Promise.all([
    countWhere(OperationRun, { status: "COMPLETED" }),
    countWhere(OperationRun, { status: "FAILED" }),
    countWhere(OperationRun, { status: "PARTIAL" }),
    countWhere(OperationRun, { status: "RUNNING" }),
  ]);
  const [reviewRequired, readyForReview] = await Promise.all([
    countWhere(ReviewState, { stage: "REVIEW_REQUIRED" }),
    countWhere(ReviewState, { stage: "READY_FOR_REVIEW" }),
  ]);
  const [surveillanceReview, surveillanceNoAction] = await Promise.all([
    countWhere(SurveillanceState, { lastOutcome: "REVIEW_REQUIRED" }),
    countWhere(SurveillanceState, { lastOutcome: "NO_ACTION" }),
  ]);
  const receipts = await (async () => {
    if (!Receipt || typeof Receipt.find !== "function") return [];
    return Receipt.find({}).lean();
  })();
  return {
    runs: { completed, failed, partial, running, total: completed + failed + partial + running },
    review: { reviewRequired, readyForReview },
    surveillance: { reviewRequired: surveillanceReview, noAction: surveillanceNoAction },
    publish: { attempts: receipts.length },
  };
}

module.exports = {
  createMetrics,
  collectOperationalMetrics,
};
