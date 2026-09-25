// =============================================================================
// scraper/operations/retention.js — STEP 13 backup / retention policy
// =============================================================================
// WHAT: Explicit, conservative retention policy for staging and operational
//   data: what is kept, for how long, what may be pruned, and what must NEVER
//   be deleted automatically. planRetention() computes prunable counts
//   read-only; applyRetention() performs pruning ONLY with explicit
//   { confirm: true, actor } and returns an auditable report.
// POLICY:
//   KEEP FOREVER (never auto-deleted, never pruned by this module):
//     raw documents (scraper_rawdocuments) — provenance bytes.
//     edition drafts (scraper_editiondrafts) — extraction history.
//     publish receipts (scraper_publish_receipts) — production linkage.
//     exam candidates (scraper_exam_candidates) — discovery evidence.
//     source profiles (scraper_source_profiles) — verification evidence.
//   PRUNABLE (explicit operator action only):
//     surveillance history entries — keep the newest KEEP_HISTORY_ENTRIES
//       (default 20) per state; older check entries may go.
//     review-state history entries — keep the newest KEEP_HISTORY_ENTRIES.
//     operation runs — terminal runs older than OPERATION_RUN_KEEP_DAYS
//       (default 90); RUNNING runs are never touched.
// WHY: History must stay small enough to operate but complete enough to
//   audit. Deletion is always explicit, attributed, and reported — silence
//   would be data loss.
// CONTRACTS:
//   planRetention({ SurveillanceState, ReviewState, OperationRun }, { now? })
//     -> { policy, prunable: { surveillanceEntries, reviewEntries,
//        operationRuns }, retained: [...] } (read-only).
//   applyRetention(models, { confirm, actor, now? })
//     -> { actor, at, pruned: {...}, retained } — throws unless confirm is
//        exactly true and actor is a non-empty string.
// GENERICITY: counts and trims only. No exam logic.
// =============================================================================

const KEEP_HISTORY_ENTRIES = 20;
const OPERATION_RUN_KEEP_DAYS = 90;

const RETAINED_COLLECTIONS = [
  "scraper_rawdocuments",
  "scraper_editiondrafts",
  "scraper_publish_receipts",
  "scraper_exam_candidates",
  "scraper_source_profiles",
];

const RETENTION_POLICY = {
  surveillanceHistory: { keepLastEntries: KEEP_HISTORY_ENTRIES, action: "prune-oldest", autoDeletable: true },
  reviewStateHistory: { keepLastEntries: KEEP_HISTORY_ENTRIES, action: "prune-oldest", autoDeletable: true },
  operationRuns: { keepDays: OPERATION_RUN_KEEP_DAYS, terminalOnly: true, action: "prune", autoDeletable: true },
  retainedForever: [...RETAINED_COLLECTIONS],
};

async function planRetention(models = {}, options = {}) {
  const { SurveillanceState, ReviewState, OperationRun } = models;
  if (!SurveillanceState || !ReviewState || !OperationRun) {
    throw new Error("retention: SurveillanceState, ReviewState, and OperationRun models are required");
  }
  const now = options.now instanceof Date ? options.now : new Date();
  const cutoff = new Date(now.getTime() - OPERATION_RUN_KEEP_DAYS * 24 * 60 * 60 * 1000);

  let surveillanceEntries = 0;
  const surveillanceStates = await SurveillanceState.find({}).lean();
  for (const state of surveillanceStates) {
    const excess = (state.history || []).length - KEEP_HISTORY_ENTRIES;
    if (excess > 0) surveillanceEntries += excess;
  }

  let reviewEntries = 0;
  const reviewStates = await ReviewState.find({}).lean();
  for (const state of reviewStates) {
    const excess = (state.history || []).length - KEEP_HISTORY_ENTRIES;
    if (excess > 0) reviewEntries += excess;
  }

  const operationRuns = await OperationRun.countDocuments({
    status: { $in: ["COMPLETED", "FAILED", "PARTIAL"] },
    finishedAt: { $lt: cutoff },
  });

  return {
    policy: RETENTION_POLICY,
    prunable: { surveillanceEntries, reviewEntries, operationRuns },
    retained: [...RETAINED_COLLECTIONS],
  };
}

async function applyRetention(models = {}, options = {}) {
  if (options.confirm !== true) {
    throw new Error("retention: pruning requires explicit { confirm: true } (never automatic)");
  }
  if (typeof options.actor !== "string" || !options.actor.trim()) {
    throw new Error("retention: pruning requires an actor name for the audit trail");
  }
  const { SurveillanceState, ReviewState, OperationRun } = models;
  if (!SurveillanceState || !ReviewState || !OperationRun) {
    throw new Error("retention: SurveillanceState, ReviewState, and OperationRun models are required");
  }
  const now = options.now instanceof Date ? options.now : new Date();
  const cutoff = new Date(now.getTime() - OPERATION_RUN_KEEP_DAYS * 24 * 60 * 60 * 1000);
  const pruned = { surveillanceEntries: 0, reviewEntries: 0, operationRuns: 0 };

  const surveillanceStates = await SurveillanceState.find({});
  for (const state of surveillanceStates) {
    const excess = (state.history || []).length - KEEP_HISTORY_ENTRIES;
    if (excess > 0) {
      state.history = state.history.slice(excess);
      await state.save();
      pruned.surveillanceEntries += excess;
    }
  }

  const reviewStates = await ReviewState.find({});
  for (const state of reviewStates) {
    const excess = (state.history || []).length - KEEP_HISTORY_ENTRIES;
    if (excess > 0) {
      state.history = state.history.slice(excess);
      await state.save();
      pruned.reviewEntries += excess;
    }
  }

  const deletable = await OperationRun.deleteMany({
    status: { $in: ["COMPLETED", "FAILED", "PARTIAL"] },
    finishedAt: { $lt: cutoff },
  });
  pruned.operationRuns = deletable.deletedCount || 0;

  return {
    actor: options.actor.trim(),
    at: now.toISOString(),
    pruned,
    retained: [...RETAINED_COLLECTIONS],
    note: "provenance collections (raw documents, drafts, receipts, candidates, profiles) are never pruned by retention",
  };
}

module.exports = {
  KEEP_HISTORY_ENTRIES,
  OPERATION_RUN_KEEP_DAYS,
  RETAINED_COLLECTIONS,
  RETENTION_POLICY,
  planRetention,
  applyRetention,
};
