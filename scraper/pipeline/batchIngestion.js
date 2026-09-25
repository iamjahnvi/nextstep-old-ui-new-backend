// =============================================================================
// scraper/pipeline/batchIngestion.js — STEP 11 batch orchestration (dry-run)
// =============================================================================
// WHAT: Multi-candidate orchestration over the Step 9 single-exam runner.
//   Selects candidates explicitly, runs each through runEndToEndIngestion
//   SEQUENTIALLY (no concurrency — deterministic order, bounded load), isolates
//   every failure to its candidate, and returns a deterministic summary.
//   Stops every candidate at DRAFT / REVIEW_REQUIRED / FAILURE. Dry-run only:
//   staging writes via the reused pipeline; no publishing path exists here
//   (this module never imports publish code and takes no ExamModel).
// WHY: Scale the proven single-exam flow to a controlled batch without
//   reimplementing it. One candidate failing (bad fetch, unverifiable source)
//   must never sink the rest, and the operator must see every terminal state.
// SELECTION (explicit only — never "everything in staging"):
//   { candidateIds: [...] } — deduplicated, first-seen order kept; longer
//     than maxCandidates throws (narrow explicitly instead).
//   { status: "DISCOVERED", limit? } — oldest-first by discoveredAt, capped at
//     min(limit, maxCandidates). Any other status value throws.
//   Empty selection throws. Unknown IDs do NOT throw here: they record a
//   per-candidate DISCOVERY_FAILED entry (isolation over fail-fast).
// ELIGIBILITY: only DISCOVERED candidates ingest. Anything else (already
//   verified, review-required, or any future state) records a skipped entry
//   and is never reprocessed — in particular nothing PUBLISHED-adjacent is
//   ever touched, because publishing lives outside this module entirely.
// BOUNDS: maxCandidates (default 5, conservative). Sequential execution only.
// CONTRACT:
//   runBatchIngestion(selection, deps, options)
//     deps: { ExamCandidate, SourceProfile, RawDocument, EditionDraft,
//             ReviewState, adapter } | resolveAdapter(candidate) via
//             options.resolveAdapter — one adapter shared by default, or an
//             explicit per-candidate resolver (never inferred).
//     options: Step 9 run options (fetchPage, fetchDocument, serviceUrl,
//                year, cycle, maxDocuments, now) + { maxCandidates? }.
//     -> { dryRun: true, total, completed, reviewRequired, failed,
//          drafts: [draftIds], results: [{ candidateId, examName, status,
//          stoppedAt, error, draftId, reviewState, durationMs }] }.
//        Terminal status per candidate: "DRAFT" (staged, review state
//        attached), "REVIEW_REQUIRED" (gate stop), or the exact failure stage
//        (FETCH_FAILED, ...). Results follow selection order — deterministic.
// GENERICITY: orchestration only. No verification/discovery/extraction logic
//   is duplicated here; every stage lives in runEndToEndIngestion.
// =============================================================================

const { runEndToEndIngestion } = require("./endToEndIngestion");

const DEFAULT_MAX_CANDIDATES = 5;

function assertStagingModels(deps) {
  for (const key of ["ExamCandidate", "SourceProfile", "RawDocument", "EditionDraft", "ReviewState"]) {
    const model = deps && deps[key];
    if (!model || !model.collection) {
      throw new Error(`batchIngestion: staging model ${key} is required`);
    }
  }
  if (deps.ExamModel) {
    throw new Error("batchIngestion: production models are refused (ingestion-only, never publishing)");
  }
}

function dedupeIds(ids) {
  const seen = new Set();
  const ordered = [];
  for (const id of ids || []) {
    if (typeof id !== "string" || !id) {
      throw new Error("batchIngestion: candidate IDs must be non-empty strings");
    }
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

async function selectCandidates(ExamCandidate, selection = {}, maxCandidates) {
  if (Array.isArray(selection.candidateIds)) {
    const ordered = dedupeIds(selection.candidateIds);
    if (ordered.length === 0) {
      throw new Error("batchIngestion: empty candidate selection (pass at least one --candidate)");
    }
    if (ordered.length > maxCandidates) {
      throw new Error(
        `batchIngestion: ${ordered.length} candidates exceed maxCandidates=${maxCandidates} (narrow the selection)`
      );
    }
    return ordered;
  }
  const status = selection.status || "DISCOVERED";
  if (status !== "DISCOVERED") {
    throw new Error(`batchIngestion: only status "DISCOVERED" selection is supported (got "${status}")`);
  }
  const limit =
    typeof selection.limit === "number" && selection.limit >= 1
      ? Math.min(Math.floor(selection.limit), maxCandidates)
      : maxCandidates;
  const found = await ExamCandidate.find({ status: "DISCOVERED" })
    .sort({ discoveredAt: 1, _id: 1 })
    .limit(limit)
    .lean();
  const ordered = dedupeIds(found.map((doc) => doc.candidateId).filter(Boolean));
  if (ordered.length === 0) {
    throw new Error("batchIngestion: empty candidate selection (no DISCOVERED candidates found)");
  }
  return ordered;
}

function toTerminalResult(run, durationMs) {
  const base = {
    candidateId: run.candidateId,
    examName: (run.stages && run.stages.load && run.stages.load.candidate && run.stages.load.candidate.name) || null,
    stoppedAt: run.stoppedAt,
    error: null,
    draftId: (run.draft && run.draft.draftId) || null,
    reviewState: (run.review && run.review.stage) || null,
    durationMs,
  };
  if (run.stoppedAt.stage === "DRAFT_REVIEW") {
    return { ...base, status: "DRAFT" };
  }
  if (run.stoppedAt.stage === "REVIEW_REQUIRED") {
    return { ...base, status: "REVIEW_REQUIRED", error: run.stoppedAt.reason };
  }
  return { ...base, status: run.stoppedAt.stage, error: run.stoppedAt.reason };
}

async function runBatchIngestion(selection, deps, options = {}) {
  if (options.dryRun === false || process.env.DRY_RUN === "false") {
    throw new Error("batchIngestion: only dry-run ingestion is supported (no publishing path exists)");
  }
  assertStagingModels(deps);
  const maxCandidates =
    typeof options.maxCandidates === "number" && options.maxCandidates >= 1
      ? Math.floor(options.maxCandidates)
      : DEFAULT_MAX_CANDIDATES;

  const ordered = await selectCandidates(deps.ExamCandidate, selection, maxCandidates);
  const results = [];
  for (const candidateId of ordered) {
    const started = Date.now();
    // Eligibility pre-check: only DISCOVERED candidates enter the pipeline.
    // Anything else (verified, review-required, future states) is recorded
    // as skipped without invoking Step 9 at all.
    const existing = await deps.ExamCandidate.findOne({ candidateId }).lean();
    if (!existing) {
      results.push({
        candidateId,
        examName: null,
        status: "DISCOVERY_FAILED",
        stoppedAt: { stage: "DISCOVERY_FAILED", reason: `candidate not found: ${candidateId}` },
        error: `candidate not found: ${candidateId}`,
        draftId: null,
        reviewState: null,
        durationMs: Date.now() - started,
      });
      continue;
    }
    if (existing.status !== "DISCOVERED") {
      results.push({
        candidateId,
        examName: existing.name || null,
        status: "skipped",
        stoppedAt: { stage: "SKIPPED", reason: `candidate status is ${existing.status}, only DISCOVERED candidates ingest` },
        error: null,
        draftId: null,
        reviewState: null,
        durationMs: Date.now() - started,
      });
      continue;
    }
    try {
      const adapter =
        typeof options.resolveAdapter === "function"
          ? await options.resolveAdapter(candidateId)
          : deps.adapter;
      if (!adapter || typeof adapter.slug !== "string") {
        throw new Error("batchIngestion: no adapter resolved for candidate " + candidateId);
      }
      const run = await runEndToEndIngestion(candidateId, { ...deps, adapter }, { ...options, dryRun: true });
      results.push(toTerminalResult(run, Date.now() - started));
    } catch (error) {
      // Isolation: an unexpected throw for one candidate never stops the batch.
      results.push({
        candidateId,
        examName: null,
        status: "FAILED",
        stoppedAt: { stage: "FAILED", reason: error.message },
        error: error.message,
        draftId: null,
        reviewState: null,
        durationMs: Date.now() - started,
      });
    }
  }

  const isTerminalOk = (r) => r.status === "DRAFT";
  const isReview = (r) => r.status === "REVIEW_REQUIRED";
  const isSkipped = (r) => r.status === "skipped";
  const summary = {
    dryRun: true,
    total: results.length,
    completed: results.filter(isTerminalOk).length,
    reviewRequired: results.filter(isReview).length,
    skipped: results.filter(isSkipped).length,
    failed: results.filter((r) => !isTerminalOk(r) && !isReview(r) && !isSkipped(r)).length,
    drafts: results.map((r) => r.draftId).filter(Boolean),
    results,
  };
  return summary;
}

module.exports = {
  DEFAULT_MAX_CANDIDATES,
  runBatchIngestion,
};
