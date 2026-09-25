// =============================================================================
// scraper/surveillance/allowlistFreshness.js — STEP 23 bulletin freshness
// =============================================================================
// WHAT: Observed-only freshness monitoring for adapter-declared bulletin URLs.
//   Each declared URL is re-probed through the existing render-aware transport,
//   snapshotted deterministically (reachability, validity, type, hash, size,
//   redirect), and compared against its stored baseline with the existing Step
//   8 compareForDrift. Outcomes: NO_ACTION (stable), REVIEW_REQUIRED (any
//   meaningful change), FAILED (probe failure with no baseline to compare).
// WHY: Declared CDN bulletin URLs rot (rotation/replacement). Freshness says
//   "look again" with both observations attached — it never rewrites the
//   adapter, never discovers a replacement, never accepts new content.
// SNAPSHOTS reuse the surveillanceState model untouched: one state document
//   per (candidateId, declared URL), baseline + append-only history. A restart
//   never erases prior observations (proven against persistent MongoDB).
// OBSERVATION (per URL): { url, finalUrl, redirectDetected, reachable,
//   accepted, documentType, contentType, byteLength, contentHash (SHA-256 of
//   bytes, PDFs) or null, reason, observedAt }. Full document bytes are never
//   stored in freshness state — the hash is the identity.
// RULES:
//   - First observation (no baseline) establishes it: NO_ACTION +
//     baselineEstablished (or FAILED when the probe itself fails).
//   - Redirect (finalUrl !== declared) is always REVIEW_REQUIRED with both
//     URLs preserved; the configured URL is never rewritten.
//   - Previously reachable, now unreachable/invalid -> REVIEW_REQUIRED with
//     the probe error as the reason (a meaningful change, not a silent drop).
//   - Hash/type/content-type/size-class change -> REVIEW_REQUIRED via
//     compareForDrift triggers. Size compares by class (empty/small/medium/
//     large bands), never exact bytes, so CDN re-encoding noise alone does
//     not page the operator... (see note below).
//   - Identical snapshots -> NO_ACTION, history still appended.
// NOTE on byteLength: compared by magnitude class (<1KB, <100KB, <1MB,
//   <1MB+... defined in SIZE_BANDS) to avoid review storms from trivial
//   re-exports; a band change still requires a hash change to matter — hash
//   equality short-circuits everything first.
// REVIEW INTEGRATION: drift records one Step 8 review item per changed URL
//   (field `allowlist:<url>`, LOW confidence, trigger + both snapshots) under
//   the shared `surveillance:<candidateId>` key via decideDraftReview +
//   recordReviewState — no competing review system.
// SCHEDULER SHAPE: runAllowlistFreshness(selection, deps, options) mirrors
//   runSurveillanceChecks ({ candidateIds } | { status?, limit? },
//   maxCandidates default 5, sequential, per-candidate isolation). Adapters
//   resolve per candidate via options.resolveAdapter (Step 11 convention) or
//   a single options.adapter.
// CONTRACTS:
//   observeAllowlistUrl({ declaredUrl, source, adapter, options? })
//     -> observation object (never throws on probe failure; records it).
//   checkAllowlistFreshness(candidateId, deps, options)
//     deps: { ExamCandidate, SurveillanceState, ReviewState } (staging only).
//     options: { adapter | resolveAdapter, fetchDocument?, now?, persist? }.
//     persist defaults true; persist: false is a pure dry-run (compare only,
//     zero writes).
//     -> { candidateId, urls: [per-URL results], driftStatus, driftTriggers,
//          reviewRequired, reviewStateKey, baselineEstablished, checkedAt }.
//        driftStatus: NO_ACTION | REVIEW_REQUIRED | FAILED (any URL drifted /
//        any probe failed without baseline).
// GENERICITY: URLs, hashes, byte counts only. No exam names, no content
//   interpretation, no LLM comparison.
// =============================================================================

const crypto = require("crypto");

const { MAX_BULLETIN_URLS } = require("../registry/schema");
const { fetchDocumentForAdapter } = require("../fetchers/transportSelector");
const { compareForDrift } = require("../review/driftReview");
const { decideDraftReview, recordReviewState } = require("../review/reviewDecision");
const { EXAM_CANDIDATE_COLLECTION } = require("../models/examCandidate");
const { SURVEILLANCE_STATE_COLLECTION } = require("../models/surveillanceState");
const { REVIEW_STATE_COLLECTION } = require("../models/reviewState");

const DEFAULT_MAX_CANDIDATES = 5;

// Magnitude bands: [0,1KB) empty-ish, [1KB,100KB), [100KB,1MB), [1MB,10MB), [10MB,∞).
function sizeBand(bytes) {
  const n = typeof bytes === "number" && bytes >= 0 ? bytes : 0;
  if (n < 1024) return "tiny";
  if (n < 102400) return "small";
  if (n < 1048576) return "medium";
  if (n < 10485760) return "large";
  return "huge";
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
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
      throw new Error(`allowlistFreshness: staging model ${key} is required`);
    }
    if (model.collection.name !== collection) {
      throw new Error(
        `allowlistFreshness: refusing model on collection "${model.collection.name}" (expected "${collection}")`
      );
    }
  }
  if (deps.ExamModel) {
    throw new Error("allowlistFreshness: production models are refused (monitoring only)");
  }
}

function declaredUrlsOf(adapter) {
  const urls = adapter && Array.isArray(adapter.bulletinUrls) ? adapter.bulletinUrls : [];
  return urls.filter((url) => typeof url === "string" && url.trim() !== "").slice(0, MAX_BULLETIN_URLS);
}

async function observeAllowlistUrl({ declaredUrl, source, adapter, options = {} } = {}) {
  if (typeof declaredUrl !== "string" || !declaredUrl) {
    throw new Error("allowlistFreshness: declaredUrl is required");
  }
  const fetchVia =
    typeof options.fetchDocument === "function"
      ? options.fetchDocument
      : async (meta) => fetchDocumentForAdapter(meta, adapter);
  const observation = {
    url: declaredUrl,
    finalUrl: declaredUrl,
    redirectDetected: false,
    reachable: false,
    accepted: false,
    documentType: null,
    contentType: null,
    byteLength: null,
    contentHash: null,
    reason: null,
    observedAt: (options.now instanceof Date ? options.now : new Date()).toISOString(),
  };
  let raw;
  try {
    raw = await fetchVia({
      label: "bulletin-allowlist-freshness",
      url: declaredUrl,
      sourceUrl: (source && source.sourceUrl) || declaredUrl,
      type: /\.pdf([?#]|$)/i.test(declaredUrl) ? "PDF" : "HTML",
    });
  } catch (error) {
    observation.reason = `fetch failed: ${error.message}`;
    return observation;
  }
  observation.reachable = true;
  const finalUrl = raw && typeof raw.url === "string" && raw.url ? raw.url : declaredUrl;
  observation.finalUrl = finalUrl;
  observation.redirectDetected = finalUrl !== declaredUrl;
  observation.documentType = (raw && raw.type) || null;
  observation.contentType = (raw && raw.contentType) || null;
  const content = raw && raw.content;
  observation.byteLength = Buffer.isBuffer(content) ? content.length : typeof content === "string" ? content.length : null;
  if (observation.documentType === "PDF" && Buffer.isBuffer(content) && content.length > 0) {
    observation.contentHash = sha256Hex(content);
    observation.accepted =
      String(observation.contentType || "").toLowerCase().includes("pdf") ||
      content.slice(0, 4).toString("latin1") === "%PDF";
    observation.reason = observation.accepted ? "reachable valid PDF" : "fetched bytes are not a valid PDF";
  } else if (typeof content === "string" && content.length > 0) {
    observation.accepted = true;
    observation.reason = "reachable non-empty document";
  } else {
    observation.reason = "fetched content is empty or unreadable";
  }
  return observation;
}

function snapshotOf(observation) {
  return {
    sourceUrl: observation.url,
    documentUrl: observation.finalUrl || observation.url,
    contentHash: observation.contentHash,
    revision: false,
    evidenceExcerpts: [],
    value: null,
  };
}

async function recordCheck(SurveillanceState, candidateId, sourceUrl, sourceDomain, snapshot, outcome, triggers, checkedAt) {
  let state = await SurveillanceState.findOne({ candidateId, sourceUrl });
  if (!state) {
    state = new SurveillanceState({
      candidateId,
      sourceUrl,
      sourceDomain: sourceDomain || hostOf(sourceUrl),
      baseline: outcome === "BASELINE" ? snapshot : null,
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

async function checkAllowlistFreshness(candidateId, deps, options = {}) {
  if (typeof candidateId !== "string" || !candidateId) {
    throw new Error("allowlistFreshness: candidateId is required");
  }
  assertStagingModels(deps);
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const checkedAt = now();

  const persist = options.persist !== false;
  const candidate = await deps.ExamCandidate.findOne({ candidateId }).lean();
  if (!candidate) {
    return {
      candidateId, examName: null, urls: [], driftStatus: "FAILED", driftTriggers: [],
      reviewRequired: false, reviewStateKey: null, baselineEstablished: false, checkedAt,
      error: `candidate not found: ${candidateId}`,
    };
  }
  const adapter =
    typeof options.resolveAdapter === "function"
      ? await options.resolveAdapter(candidate)
      : options.adapter || null;
  const declared = declaredUrlsOf(adapter);
  if (declared.length === 0) {
    return {
      candidateId, examName: candidate.name || null, urls: [], driftStatus: "NO_ACTION", driftTriggers: [],
      reviewRequired: false, reviewStateKey: null, baselineEstablished: false, checkedAt,
      note: "adapter declares no bulletinUrls; nothing to watch",
    };
  }

  const source = { sourceUrl: candidate.sourceUrl, sourceDomain: candidate.sourceDomain };
  const urlResults = [];
  let anyDrift = false;
  let anyFailed = false;
  const reviewItems = [];
  const allTriggers = new Set();

  for (const declaredUrl of declared) {
    const observation = await observeAllowlistUrl({ declaredUrl, source, adapter, options });
    const stored = await deps.SurveillanceState.findOne({ candidateId, sourceUrl: declaredUrl });
    const previous = stored && stored.history.length > 0
      ? stored.history[stored.history.length - 1].snapshot
      : stored && stored.baseline
        ? stored.baseline
        : null;
    const entry = {
      url: declaredUrl,
      finalUrl: observation.finalUrl,
      redirectDetected: observation.redirectDetected,
      reachable: observation.reachable,
      accepted: observation.accepted,
      documentType: observation.documentType,
      contentType: observation.contentType,
      byteLength: observation.byteLength,
      sizeBand: sizeBand(observation.byteLength),
      contentHash: observation.contentHash,
      reason: observation.reason,
      observedAt: observation.observedAt,
      outcome: null,
      triggers: [],
      baselineEstablished: false,
    };

    if (!previous) {
      if (!observation.reachable || !observation.accepted) {
        entry.outcome = "FAILED";
        anyFailed = true;
      } else {
        entry.outcome = "NO_ACTION";
        entry.baselineEstablished = true;
      }
      if (persist) {
        await recordCheck(deps.SurveillanceState, candidateId, declaredUrl, candidate.sourceDomain, observation.accepted ? snapshotOf(observation) : null, entry.outcome === "FAILED" ? "FAILED" : "BASELINE", [], checkedAt);
      }
      urlResults.push(entry);
      continue;
    }

    const current = snapshotOf(observation);
    if (!observation.reachable || !observation.accepted) {
      // Previously working, now not: a meaningful change, never silent.
      entry.outcome = "REVIEW_REQUIRED";
      entry.triggers = [];
      entry.reason = `previously reachable, now failing: ${observation.reason}`;
      anyDrift = true;
    } else {
      const comparison = compareForDrift({ previous, current });
      const redirectTrigger = observation.redirectDetected
        ? [{ type: "redirect-detected", detail: `declared URL redirects to ${observation.finalUrl}` }]
        : [];
      const triggers = [...comparison.triggers.map((t) => t.type), ...redirectTrigger.map((t) => t.type)];
      entry.outcome = comparison.drifted || redirectTrigger.length > 0 ? "REVIEW_REQUIRED" : "NO_ACTION";
      entry.triggers = triggers;
      if (entry.outcome === "REVIEW_REQUIRED") anyDrift = true;
    }
    for (const trigger of entry.triggers) allTriggers.add(trigger);
    if (persist) {
      await recordCheck(
        deps.SurveillanceState, candidateId, declaredUrl, candidate.sourceDomain,
        observation.accepted || observation.reachable ? current : null,
        entry.outcome, entry.triggers, checkedAt
      );
    }
    if (entry.outcome === "REVIEW_REQUIRED") {
      reviewItems.push({
        field: `allowlist:${declaredUrl}`,
        currentValue: observation.contentHash,
        confidence: "LOW",
        reviewStatus: "REVIEW_REQUIRED",
        sourceDocuments: [observation.finalUrl || declaredUrl],
        pageNumbers: [],
        sections: [],
        excerpts: [],
        reconciliation: null,
        llmProposal: null,
        reason: `allowlist drift (${entry.triggers.join(", ") || entry.reason}); prior snapshot preserved for operator comparison`,
      });
    }
    urlResults.push(entry);
  }

  let reviewStateKey = null;
  if (reviewItems.length > 0) {
    const decision = decideDraftReview(reviewItems);
    reviewStateKey = `surveillance:${candidateId}`;
    if (persist) {
      await recordReviewState(deps.ReviewState, reviewStateKey, { stage: decision.stage, items: reviewItems }, {});
    }
  }

  const failedWithoutBaseline = urlResults.some((entry) => entry.outcome === "FAILED");
  return {
    candidateId,
    examName: candidate.name || null,
    urls: urlResults,
    driftStatus: anyDrift ? "REVIEW_REQUIRED" : failedWithoutBaseline ? "FAILED" : "NO_ACTION",
    driftTriggers: [...allTriggers],
    reviewRequired: anyDrift,
    reviewStateKey,
    baselineEstablished: urlResults.some((entry) => entry.baselineEstablished),
    checkedAt,
  };
}



function dedupeIds(ids) {
  const seen = new Set();
  const ordered = [];
  for (const id of ids || []) {
    if (typeof id !== "string" || !id) {
      throw new Error("allowlistFreshness: candidate IDs must be non-empty strings");
    }
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

async function runAllowlistFreshness(selection, deps, options = {}) {
  assertStagingModels(deps);
  const maxCandidates =
    typeof options.maxCandidates === "number" && options.maxCandidates >= 1
      ? Math.floor(options.maxCandidates)
      : DEFAULT_MAX_CANDIDATES;
  let ordered;
  if (Array.isArray(selection.candidateIds)) {
    ordered = dedupeIds(selection.candidateIds);
    if (ordered.length === 0) {
      throw new Error("allowlistFreshness: empty candidate selection (pass at least one --candidate)");
    }
    if (ordered.length > maxCandidates) {
      throw new Error(
        `allowlistFreshness: ${ordered.length} candidates exceed maxCandidates=${maxCandidates} (narrow the selection)`
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
      throw new Error("allowlistFreshness: empty candidate selection (no candidates found)");
    }
  }

  const results = [];
  for (const candidateId of ordered) {
    const started = Date.now();
    try {
      const result = await checkAllowlistFreshness(candidateId, deps, options);
      results.push({ ...result, durationMs: Date.now() - started });
    } catch (error) {
      results.push({
        candidateId, examName: null, urls: [], driftStatus: "FAILED", driftTriggers: [],
        reviewRequired: false, reviewStateKey: null, baselineEstablished: false,
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
  DEFAULT_MAX_CANDIDATES,
  sizeBand,
  declaredUrlsOf,
  observeAllowlistUrl,
  checkAllowlistFreshness,
  runAllowlistFreshness,
};
