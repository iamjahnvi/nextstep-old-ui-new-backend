// =============================================================================
// scraper/surveillance/sourceSurveillance.js — STEP 12 surveillance checks
// =============================================================================
// WHAT: Periodic re-checks of already-ingested sources. For one candidate:
//   load the stored baseline → fetch current content → hash it → compare with
//   the existing Step 8 compareForDrift → NO_ACTION, REVIEW_REQUIRED (with a
//   Step 8 review state), or FAILED. Multi-candidate runs isolate every
//   failure. Surveillance watches and triggers; it never updates exam data,
//   never accepts new content, never publishes.
// WHY: Official sources move (re-uploads, URL changes, corrigenda). A value
//   reviewed last month must not silently survive its evidence disappearing.
//   The check says "look again" with both snapshots attached — the operator
//   decides what the change means.
// SNAPSHOTS: { sourceUrl, documentUrl, contentHash (sha256 of fetched bytes),
//   revision (URL marker — same marker list as document discovery, imported
//   not duplicated), evidenceExcerpts, value }. Transport-level signals
//   (url/hash/revision) come from the fetch itself; content-level signals
//   (fresh excerpts/value) arrive via options.observe when the caller holds
//   them (e.g. a later re-extraction) — otherwise the stored ones carry
//   forward and only transport drift can fire. This is documented, not hidden.
// FIRST RUN: no baseline exists → the fresh snapshot becomes the baseline,
//   outcome NO_ACTION with baselineEstablished: true. Nothing to compare is
//   not drift.
// REVIEW INTEGRATION: drift records a Step 8 review state (decideDraftReview
//   + recordReviewState — no competing system) keyed `surveillance:<id>`,
//   with one item naming the trigger, source, documents, and both evidences.
// CONTRACTS:
//   checkCandidateSource(candidateId, deps, options)
//     deps: { ExamCandidate, SurveillanceState, ReviewState } (staging only).
//     options: { sourceUrl?, fetchContent?, observe?, persist? (default true),
//                now? } — fetchContent defaults to the existing binary
//                fetcher; inject a stub in tests.
//     -> { candidateId, examName, sourceUrl, previousSnapshot,
//          currentSnapshot, driftStatus, driftTriggers, reviewRequired,
//          reviewStateKey, baselineEstablished, checkedAt, error? }.
//        driftStatus: NO_ACTION | REVIEW_REQUIRED | FAILED.
//   runSurveillanceChecks(selection, deps, options)
//     selection like batchIngestion ({ candidateIds } | { status, limit },
//     maxCandidates default 5) but resolved against candidates that HAVE a
//     baseline or are being baselined — every known candidate is checkable.
//     -> { dryRun, total, noAction, reviewRequired, failed, results[] }.
//        One candidate's FAILED never stops the rest.
// GENERICITY: no exam names, no content interpretation — hashes and string
//   equality only.
// =============================================================================

const crypto = require("crypto");

const { compareForDrift } = require("../review/driftReview");
const { decideDraftReview, recordReviewState } = require("../review/reviewDecision");
const { REVISION_MARKERS } = require("../discovery/documentDiscovery");
const { EXAM_CANDIDATE_COLLECTION } = require("../models/examCandidate");
const { SURVEILLANCE_STATE_COLLECTION } = require("../models/surveillanceState");
const { REVIEW_STATE_COLLECTION } = require("../models/reviewState");

const SURVEILLANCE_OUTCOMES = ["NO_ACTION", "REVIEW_REQUIRED", "FAILED"];
const DEFAULT_MAX_CANDIDATES = 5;

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hasRevisionMarker(url) {
  const lower = String(url || "").toLowerCase();
  return REVISION_MARKERS.some((marker) => lower.includes(marker));
}

function assertStagingModels(deps) {
  const expectations = [
    ["ExamCandidate", EXAM_CANDIDATE_COLLECTION],
    ["SurveillanceState", SURVEILLANCE_STATE_COLLECTION],
    ["ReviewState", REVIEW_STATE_COLLECTION],
  ];
  for (const [key, collection] of expectations) {
    const model = deps && deps[key];
    if (!model || !model.collection) {
      throw new Error(`sourceSurveillance: staging model ${key} is required`);
    }
    if (model.collection.name !== collection) {
      throw new Error(
        `sourceSurveillance: refusing model on collection "${model.collection.name}" (expected "${collection}")`
      );
    }
  }
  if (deps.ExamModel) {
    throw new Error("sourceSurveillance: production models are refused (surveillance never publishes)");
  }
}

async function defaultFetchContent(url) {
  const { fetchBinary } = require("../fetchers/httpFetcher");
  const res = await fetchBinary(url, { retries: 0 });
  return { url: res.url, content: res.buffer };
}

function toBytes(content) {
  if (Buffer.isBuffer(content)) return content;
  return Buffer.from(String(content === undefined || content === null ? "" : content), "utf8");
}

async function checkCandidateSource(candidateId, deps, options = {}) {
  if (typeof candidateId !== "string" || !candidateId) {
    throw new Error("sourceSurveillance: candidateId is required");
  }
  assertStagingModels(deps);
  const persist = options.persist !== false;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const checkedAt = now();

  const candidate = await deps.ExamCandidate.findOne({ candidateId }).lean();
  if (!candidate) {
    return {
      candidateId, examName: null, sourceUrl: null,
      previousSnapshot: null, currentSnapshot: null,
      driftStatus: "FAILED", driftTriggers: [], reviewRequired: false,
      reviewStateKey: null, baselineEstablished: false, checkedAt,
      error: `candidate not found: ${candidateId}`,
    };
  }
  const sourceUrl = typeof options.sourceUrl === "string" && options.sourceUrl
    ? options.sourceUrl
    : candidate.sourceUrl;

  const fetchContent = typeof options.fetchContent === "function" ? options.fetchContent : defaultFetchContent;
  let fetched;
  try {
    fetched = await fetchContent(sourceUrl);
  } catch (error) {
    const failed = {
      candidateId, examName: candidate.name || null, sourceUrl,
      previousSnapshot: null, currentSnapshot: null,
      driftStatus: "FAILED", driftTriggers: [], reviewRequired: false,
      reviewStateKey: null, baselineEstablished: false, checkedAt,
      error: (error && error.message) || String(error),
    };
    if (persist) {
      await recordCheck(deps.SurveillanceState, candidate, sourceUrl, null, "FAILED", [], checkedAt);
    }
    return failed;
  }

  const observe = options.observe || {};
  const stored = await deps.SurveillanceState.findOne({ candidateId, sourceUrl });
  const previous = stored && stored.history.length > 0
    ? stored.history[stored.history.length - 1].snapshot
    : stored && stored.baseline
      ? stored.baseline
      : null;
  const currentSnapshot = {
    sourceUrl,
    documentUrl: (fetched && fetched.url) || sourceUrl,
    contentHash: sha256Hex(toBytes(fetched && fetched.content)),
    // An explicit observation wins; otherwise fall back to URL markers.
    revision: typeof observe.revision === "boolean"
      ? observe.revision
      : hasRevisionMarker((fetched && fetched.url) || sourceUrl),
    evidenceExcerpts: Array.isArray(observe.evidenceExcerpts)
      ? observe.evidenceExcerpts
      : previous
        ? previous.evidenceExcerpts || []
        : [],
    value: "value" in observe ? observe.value : previous ? previous.value : null,
  };

  if (!previous) {
    if (persist) {
      await recordCheck(deps.SurveillanceState, candidate, sourceUrl, currentSnapshot, "BASELINE", [], checkedAt, true);
    }
    return {
      candidateId, examName: candidate.name || null, sourceUrl,
      previousSnapshot: null, currentSnapshot,
      driftStatus: "NO_ACTION", driftTriggers: [], reviewRequired: false,
      reviewStateKey: null, baselineEstablished: true, checkedAt,
    };
  }

  const comparison = compareForDrift({ previous, current: currentSnapshot });
  const driftTriggers = comparison.triggers.map((t) => t.type);
  let reviewStateKey = null;
  if (comparison.drifted) {
    const item = {
      field: "source-drift",
      currentValue: currentSnapshot.contentHash,
      confidence: "LOW",
      reviewStatus: "REVIEW_REQUIRED",
      sourceDocuments: [currentSnapshot.documentUrl || currentSnapshot.sourceUrl].filter(Boolean),
      pageNumbers: [],
      sections: [],
      excerpts: currentSnapshot.evidenceExcerpts,
      reconciliation: null,
      llmProposal: null,
      reason: `drift triggers: ${driftTriggers.join(", ")}; previous evidence preserved for operator comparison`,
    };
    const decision = decideDraftReview([item]);
    reviewStateKey = `surveillance:${candidateId}`;
    if (persist) {
      await recordReviewState(deps.ReviewState, reviewStateKey, { stage: decision.stage, items: [item] }, {});
    }
  }
  if (persist) {
    await recordCheck(deps.SurveillanceState, candidate, sourceUrl, currentSnapshot, comparison.drifted ? "REVIEW_REQUIRED" : "NO_ACTION", driftTriggers, checkedAt, false);
  }
  return {
    candidateId, examName: candidate.name || null, sourceUrl,
    previousSnapshot: previous,
    currentSnapshot,
    driftStatus: comparison.drifted ? "REVIEW_REQUIRED" : "NO_ACTION",
    driftTriggers,
    reviewRequired: comparison.drifted,
    reviewStateKey,
    baselineEstablished: false,
    checkedAt,
  };
}

async function recordCheck(SurveillanceState, candidate, sourceUrl, snapshot, outcome, triggers, checkedAt, isBaseline) {
  let state = await SurveillanceState.findOne({ candidateId: candidate.candidateId, sourceUrl });
  if (!state) {
    state = new SurveillanceState({
      candidateId: candidate.candidateId,
      sourceUrl,
      sourceDomain: hostOf(sourceUrl),
      baseline: isBaseline ? snapshot : null,
      history: [],
      lastOutcome: outcome,
      reviewStateKey: null,
    });
  }
  state.history.push({ checkedAt, outcome, triggers: [...triggers], snapshot });
  state.lastOutcome = outcome;
  await state.save();
  return state;
}

function dedupeIds(ids) {
  const seen = new Set();
  const ordered = [];
  for (const id of ids || []) {
    if (typeof id !== "string" || !id) {
      throw new Error("sourceSurveillance: candidate IDs must be non-empty strings");
    }
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

async function runSurveillanceChecks(selection, deps, options = {}) {
  assertStagingModels(deps);
  const maxCandidates =
    typeof options.maxCandidates === "number" && options.maxCandidates >= 1
      ? Math.floor(options.maxCandidates)
      : DEFAULT_MAX_CANDIDATES;
  let ordered;
  if (Array.isArray(selection.candidateIds)) {
    ordered = dedupeIds(selection.candidateIds);
    if (ordered.length === 0) {
      throw new Error("sourceSurveillance: empty candidate selection (pass at least one --candidate)");
    }
    if (ordered.length > maxCandidates) {
      throw new Error(
        `sourceSurveillance: ${ordered.length} candidates exceed maxCandidates=${maxCandidates} (narrow the selection)`
      );
    }
  } else {
    const limit =
      typeof selection.limit === "number" && selection.limit >= 1
        ? Math.min(Math.floor(selection.limit), maxCandidates)
        : maxCandidates;
    const found = await deps.ExamCandidate.find({})
      .sort({ discoveredAt: 1, _id: 1 })
      .limit(limit)
      .lean();
    ordered = dedupeIds(found.map((doc) => doc.candidateId).filter(Boolean));
    if (ordered.length === 0) {
      throw new Error("sourceSurveillance: empty candidate selection (no candidates found)");
    }
  }

  const results = [];
  for (const candidateId of ordered) {
    const started = Date.now();
    try {
      const result = await checkCandidateSource(candidateId, deps, options);
      results.push({ ...result, durationMs: Date.now() - started });
    } catch (error) {
      results.push({
        candidateId, examName: null, sourceUrl: null,
        previousSnapshot: null, currentSnapshot: null,
        driftStatus: "FAILED", driftTriggers: [], reviewRequired: false,
        reviewStateKey: null, baselineEstablished: false,
        checkedAt: new Date(), error: error.message, durationMs: Date.now() - started,
      });
    }
  }
  return {
    dryRun: options.persist === false,
    total: results.length,
    noAction: results.filter((r) => r.driftStatus === "NO_ACTION").length,
    reviewRequired: results.filter((r) => r.driftStatus === "REVIEW_REQUIRED").length,
    failed: results.filter((r) => r.driftStatus === "FAILED").length,
    results,
  };
}

module.exports = {
  SURVEILLANCE_OUTCOMES,
  DEFAULT_MAX_CANDIDATES,
  checkCandidateSource,
  runSurveillanceChecks,
};
