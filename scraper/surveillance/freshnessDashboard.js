// =============================================================================
// scraper/surveillance/freshnessDashboard.js — STEP 25 read-only data layer
// =============================================================================

const { DEFAULT_MAX_CANDIDATES } = require("./allowlistFreshness");
const { getEffectiveBulletinUrls } = require("../operations/allowlistResolution");
const { EXAM_CANDIDATE_COLLECTION } = require("../models/examCandidate");
const { SURVEILLANCE_STATE_COLLECTION } = require("../models/surveillanceState");
const { REVIEW_STATE_COLLECTION } = require("../models/reviewState");
const { ALLOWLIST_DECLARATION_COLLECTION } = require("../models/allowlistDeclaration");

const FRESHNESS_STATUSES = ["NO_ACTION", "REVIEW_REQUIRED", "FAILED"];

class DashboardRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "DashboardRequestError";
    this.statusCode = 400;
  }
}

function normalizeFilters(filters = {}) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    throw new DashboardRequestError("filters must be an object");
  }
  const limit = filters.limit === undefined ? DEFAULT_MAX_CANDIDATES : Number(filters.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new DashboardRequestError("limit must be a positive integer");
  }
  if (
    filters.candidateId !== undefined &&
    (typeof filters.candidateId !== "string" || !filters.candidateId.trim())
  ) {
    throw new DashboardRequestError("candidateId must be a non-empty string");
  }
  if (
    filters.status !== undefined &&
    !FRESHNESS_STATUSES.includes(filters.status)
  ) {
    throw new DashboardRequestError(`status must be one of ${FRESHNESS_STATUSES.join("|")}`);
  }
  if (limit > DEFAULT_MAX_CANDIDATES) {
    throw new DashboardRequestError(
      `limit must not exceed ${DEFAULT_MAX_CANDIDATES}`
    );
  }
  return {
    candidateId: filters.candidateId ? filters.candidateId.trim() : null,
    limit,
    status: filters.status || null,
  };
}

function assertStagingModels(models) {
  const expected = [
    ["ExamCandidate", EXAM_CANDIDATE_COLLECTION],
    ["SurveillanceState", SURVEILLANCE_STATE_COLLECTION],
    ["ReviewState", REVIEW_STATE_COLLECTION],
    ["AllowlistDeclaration", ALLOWLIST_DECLARATION_COLLECTION],
  ];
  for (const [key, collection] of expected) {
    const model = models && models[key];
    if (!model || !model.collection || model.collection.name !== collection) {
      throw new Error(`freshnessDashboard: staging model ${key} is required on ${collection}`);
    }
  }
  if (models.ExamModel) {
    throw new Error("freshnessDashboard: production models are refused");
  }
}

function dateValue(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function statusOf(states) {
  const outcomes = states.map((state) => {
    const latest = state.history && state.history.length > 0
      ? state.history[state.history.length - 1].outcome
      : state.lastOutcome;
    return latest === "BASELINE" ? "NO_ACTION" : latest;
  });
  if (outcomes.includes("REVIEW_REQUIRED")) return "REVIEW_REQUIRED";
  if (outcomes.includes("FAILED")) return "FAILED";
  return outcomes.includes("NO_ACTION") ? "NO_ACTION" : null;
}

function latestHistory(state) {
  const history = Array.isArray(state.history) ? state.history : [];
  if (history.length === 0) return null;
  const entry = history[history.length - 1];
  return {
    checkedAt: dateValue(entry.checkedAt),
    outcome: entry.outcome,
    triggers: Array.isArray(entry.triggers) ? entry.triggers : [],
    snapshot: entry.snapshot || null,
  };
}

function baselineObservation(state) {
  if (!state.baseline) return null;
  const history = Array.isArray(state.history) ? state.history : [];
  const baselineEntry = history.find((entry) => entry.outcome === "BASELINE");
  return {
    checkedAt: baselineEntry ? dateValue(baselineEntry.checkedAt) : null,
    snapshot: state.baseline,
  };
}

async function buildCandidateView(candidate, states, review, declaration, adapter) {
  const adapterConfig = adapter || null;
  const effective = adapterConfig
    ? await getEffectiveBulletinUrls({
        adapter: adapterConfig,
        AllowlistDeclaration: declaration.model,
      })
    : { urls: [], retired: [], source: "unmapped" };
  const declarationDoc = declaration.document;
  const activeUrls = effective.urls;
  const retiredUrls = effective.retired;
  const byUrl = new Map(states.map((state) => [state.sourceUrl, state]));
  const urls = [...new Set([...activeUrls, ...retiredUrls, ...byUrl.keys()])].sort();
  const reviewItems = review && Array.isArray(review.items) ? review.items : [];
  const bulletins = urls.map((url) => {
    const state = byUrl.get(url);
    const matchingReviewItems = reviewItems.filter((item) => item &&
      item.field === `allowlist:${url}`);
    const latest = state ? latestHistory(state) : null;
    const resolutionHistory = declarationDoc && Array.isArray(declarationDoc.resolutions)
      ? declarationDoc.resolutions
        .filter((entry) => entry.oldUrl === url || entry.newUrl === url)
        .map((entry) => ({
          reviewId: entry.reviewId,
          decision: entry.decision,
          oldUrl: entry.oldUrl,
          newUrl: entry.newUrl || null,
          reason: entry.reason,
          timestamp: dateValue(entry.timestamp),
        }))
      : [];
    const active = activeUrls.includes(url);
    const retired = retiredUrls.includes(url);
    return {
      url,
      declarationStatus: active ? "active" : retired ? "retired" : adapterConfig ? "inactive" : "unknown",
      freshnessStatus: state ? statusOf([state]) : null,
      reasons: [
        ...(latest ? latest.triggers : []),
        ...matchingReviewItems.map((item) => item.reason).filter(Boolean),
      ],
      latestObservation: latest,
      baselineObservation: state ? baselineObservation(state) : null,
      historyCount: state && Array.isArray(state.history) ? state.history.length : 0,
      latestHistory: latest,
      linkedReview: review
        ? {
            reviewKey: review.draftId,
            stage: review.stage,
            decidedAt: dateValue(review.decidedAt),
            updatedAt: dateValue(review.updatedAt),
            items: matchingReviewItems,
          }
        : null,
      resolutionHistory,
    };
  });
  const activeStates = bulletins
    .filter((bulletin) =>
      ["active", "unknown"].includes(bulletin.declarationStatus) && bulletin.freshnessStatus
    )
    .map((bulletin) => ({ lastOutcome: bulletin.freshnessStatus }));
  const candidateStatus = statusOf(activeStates);
  const relevantReviewItems = reviewItems.filter((item) =>
    item && typeof item.field === "string" && item.field.startsWith("allowlist:")
  );
  return {
    candidate: {
      candidateId: candidate.candidateId,
      name: candidate.name,
      conductingBody: candidate.conductingBody || null,
      year: candidate.year || null,
      status: candidate.status,
      adapterSlug: adapterConfig ? adapterConfig.slug : null,
      declarationSource: adapterConfig ? effective.source : "unmapped",
    },
    freshnessStatus: candidateStatus,
    reviewReasons: relevantReviewItems.map((item) => item.reason).filter(Boolean),
    linkedReview: review
      ? {
          reviewKey: review.draftId,
          stage: review.stage,
          decidedAt: dateValue(review.decidedAt),
          updatedAt: dateValue(review.updatedAt),
        }
      : null,
    bulletins,
  };
}

async function getFreshnessDashboard(filters, models, options = {}) {
  assertStagingModels(models);
  const normalized = normalizeFilters(filters);
  const candidateQuery = normalized.candidateId
    ? { candidateId: normalized.candidateId }
    : {};
  const candidates = await models.ExamCandidate.find(candidateQuery)
    .sort({ discoveredAt: 1, candidateId: 1 })
    .limit(normalized.candidateId ? 1 : normalized.status ? DEFAULT_MAX_CANDIDATES : normalized.limit)
    .lean();
  const candidateIds = candidates.map((candidate) => candidate.candidateId);
  if (candidateIds.length === 0) {
    return { limit: normalized.limit, statusFilter: normalized.status, total: 0, results: [] };
  }
  const reviewKeys = candidateIds.map((candidateId) => `surveillance:${candidateId}`);
  const [states, reviews] = await Promise.all([
    models.SurveillanceState.find({ candidateId: { $in: candidateIds } })
      .sort({ candidateId: 1, sourceUrl: 1 })
      .lean(),
    models.ReviewState.find({ draftId: { $in: reviewKeys } }).lean(),
  ]);
  const statesByCandidate = new Map(candidateIds.map((candidateId) => [candidateId, []]));
  for (const state of states) statesByCandidate.get(state.candidateId).push(state);
  const reviewsByCandidate = new Map(
    reviews.map((review) => [review.draftId.replace(/^surveillance:/, ""), review])
  );
  const results = [];
  for (const candidate of candidates) {
    const adapter = typeof options.resolveAdapter === "function"
      ? await options.resolveAdapter(candidate)
      : null;
    const adapterSlug = adapter && adapter.slug;
    const declarationDoc = adapterSlug
      ? await models.AllowlistDeclaration.findOne({ adapterSlug }).lean()
      : null;
    const view = await buildCandidateView(
      candidate,
      statesByCandidate.get(candidate.candidateId),
      reviewsByCandidate.get(candidate.candidateId) || null,
      { model: models.AllowlistDeclaration, document: declarationDoc },
      adapter
    );
    if (!normalized.status || view.freshnessStatus === normalized.status) {
      results.push(view);
      if (results.length === normalized.limit) break;
    }
  }
  return {
    limit: normalized.limit,
    statusFilter: normalized.status,
    total: results.length,
    results,
  };
}

module.exports = {
  FRESHNESS_STATUSES,
  DEFAULT_MAX_CANDIDATES,
  DashboardRequestError,
  normalizeFilters,
  getFreshnessDashboard,
};
