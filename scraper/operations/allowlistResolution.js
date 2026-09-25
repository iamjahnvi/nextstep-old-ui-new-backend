// =============================================================================
// scraper/operations/allowlistResolution.js — STEP 24 operator resolution
// =============================================================================
// WHAT: Explicit operator workflow for resolving Step 23 allowlist freshness
//   reviews: UPDATE (confirm a replacement URL with evidence) or RETIRE (mark
//   a declaration inactive). Detection stays automatic; every remediation is
//   human, validated, and audited.
// WHY: A rotated CDN URL must never be auto-replaced, auto-discovered, or
//   silently dropped. The pipeline detects; the operator reviews; the system
//   validates the operator's explicit choice and records an immutable audit
//   trail. Adapter JS files are never edited at runtime — declarations live
//   as versioned staging records (models/allowlistDeclaration.js) shadowing
//   the adapter default, so history survives and nothing is lost.
// FLOW:
//   inspect  -> review state + linked surveillance observations, read-only.
//   UPDATE   -> presence/provenance checks -> URL syntax check -> probe the
//               exact new URL through the render-aware transport -> shared
//               document gate must accept -> persist new declaration + audit
//               + fresh baseline for the new URL.
//   RETIRE   -> presence/provenance checks -> mark inactive, keep everything.
// RULES (all rejections throw with explicit reasons; nothing is auto-fixed):
//   missing operator / reason / evidence.source / evidence.verification,
//   unknown review, no review item for the URL, already-resolved review+URL
//   (idempotent no-op), invalid/unreachable new URL, over-cap resulting
//   list, unknown old declaration.
// CONTRACTS (staging models only, never production):
//   getEffectiveBulletinUrls({ adapter, AllowlistDeclaration })
//     -> { urls, retired, source: "adapter" | "override" }.
//   inspectFreshnessReview({ ReviewState, SurveillanceState }, reviewKey)
//     -> { review, items: [{ item, observation, baseline }] }.
//   resolveUpdate({ models, reviewKey, url, newUrl, operator, reason,
//                   evidence, adapter, options })
//     -> { resolved: true, declaration, baseline, audit }.
//   resolveRetire({ models, reviewKey, url, operator, reason, evidence,
//                   adapter })
//     -> { resolved: true, declaration, audit }.
// GENERICITY: URLs and audit shapes only. No exam names, no content logic.
// =============================================================================

const crypto = require("crypto");

const { MAX_BULLETIN_URLS } = require("../registry/schema");
const { probeAllowlistUrls } = require("../discovery/bulletinFallback");
const { EXAM_CANDIDATE_COLLECTION } = require("../models/examCandidate");
const { SURVEILLANCE_STATE_COLLECTION } = require("../models/surveillanceState");
const { REVIEW_STATE_COLLECTION } = require("../models/reviewState");
const { ALLOWLIST_DECLARATION_COLLECTION } = require("../models/allowlistDeclaration");

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertStagingModels(deps) {
  const expectations = [
    ["ExamCandidate", EXAM_CANDIDATE_COLLECTION],
    ["SurveillanceState", SURVEILLANCE_STATE_COLLECTION],
    ["ReviewState", REVIEW_STATE_COLLECTION],
    ["AllowlistDeclaration", ALLOWLIST_DECLARATION_COLLECTION],
  ];
  for (const [key, collection] of expectations) {
    const model = deps && deps[key];
    if (!model || !model.collection) {
      throw new Error(`allowlistResolution: staging model ${key} is required`);
    }
    if (model.collection.name !== collection) {
      throw new Error(
        `allowlistResolution: refusing model on collection "${model.collection.name}" (expected "${collection}")`
      );
    }
  }
  if (deps.ExamModel) {
    throw new Error("allowlistResolution: production models are refused (no publishing path exists here)");
  }
}

function requireProvenance({ operator, reason, evidence }, decision) {
  if (typeof operator !== "string" || !operator.trim()) {
    throw new Error(`allowlistResolution: ${decision} requires an operator name`);
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error(`allowlistResolution: ${decision} requires a reason`);
  }
  if (!evidence || typeof evidence !== "object") {
    throw new Error(`allowlistResolution: ${decision} requires evidence`);
  }
  if (typeof evidence.source !== "string" || !evidence.source.trim()) {
    throw new Error(`allowlistResolution: ${decision} requires evidence.source`);
  }
  if (typeof evidence.verification !== "string" || !evidence.verification.trim()) {
    throw new Error(`allowlistResolution: ${decision} requires evidence.verification`);
  }
  return { operator: operator.trim(), reason: reason.trim(), evidence };
}

function declaredFallback(adapter) {
  return Array.isArray(adapter && adapter.bulletinUrls)
    ? adapter.bulletinUrls.filter((url) => typeof url === "string" && url.trim() !== "")
    : [];
}

async function getEffectiveBulletinUrls({ adapter, AllowlistDeclaration }) {
  const fallback = declaredFallback(adapter);
  if (!AllowlistDeclaration) return { urls: fallback, retired: [], source: "adapter" };
  const slug = adapter && adapter.slug;
  const doc = slug ? await AllowlistDeclaration.findOne({ adapterSlug: slug }).lean() : null;
  if (!doc) return { urls: fallback, retired: [], source: "adapter" };
  return {
    urls: (doc.urls || []).filter((url) => typeof url === "string" && url.trim() !== ""),
    retired: (doc.retired || []).filter((url) => typeof url === "string" && url.trim() !== ""),
    source: "override",
  };
}

function candidateIdOf(reviewKey) {
  return String(reviewKey).replace(/^surveillance:/, "");
}

function reviewIdOf(reviewKey, url) {
  return `${reviewKey}::${url}`;
}

async function inspectFreshnessReview({ ReviewState, SurveillanceState }, reviewKey) {
  if (!ReviewState || !ReviewState.collection) {
    throw new Error("allowlistResolution: a review-state model is required");
  }
  if (typeof reviewKey !== "string" || !reviewKey) {
    throw new Error("allowlistResolution: review key is required");
  }
  const review = await ReviewState.findOne({ draftId: reviewKey }).lean();
  if (!review) {
    throw new Error(`allowlistResolution: unknown review "${reviewKey}"`);
  }
  const items = Array.isArray(review.items) ? review.items : [];
  const allowlistItems = items.filter(
    (item) => item && typeof item.field === "string" && item.field.startsWith("allowlist:")
  );
  const enriched = [];
  for (const item of allowlistItems) {
    const url = item.field.slice("allowlist:".length);
    let observation = null;
    let baseline = null;
    if (SurveillanceState) {
      const state = await SurveillanceState.findOne({
        candidateId: candidateIdOf(reviewKey),
        sourceUrl: url,
      }).lean();
      if (state) {
        const last = state.history.length > 0 ? state.history[state.history.length - 1] : null;
        observation = last ? last.snapshot : null;
        baseline = state.baseline || null;
      }
    }
    enriched.push({ item, observation, baseline });
  }
  return { review, items: enriched };
}

async function loadDeclaration(AllowlistDeclaration, adapter) {
  let doc = await AllowlistDeclaration.findOne({ adapterSlug: adapter.slug });
  if (!doc) {
    doc = new AllowlistDeclaration({
      adapterSlug: adapter.slug,
      urls: declaredFallback(adapter),
      retired: [],
      resolutions: [],
    });
  }
  return doc;
}

function findResolution(doc, reviewKey, oldUrl) {
  return (doc.resolutions || []).find(
    (entry) => entry.reviewId === reviewIdOf(reviewKey, oldUrl) && entry.oldUrl === oldUrl
  );
}

function pushAudit(doc, audit) {
  doc.resolutions.push({
    reviewId: audit.reviewId,
    candidateId: audit.candidateId,
    decision: audit.decision,
    operator: audit.operator,
    oldUrl: audit.oldUrl,
    newUrl: audit.newUrl === undefined ? null : audit.newUrl,
    reason: audit.reason,
    evidence: audit.evidence,
    timestamp: audit.timestamp instanceof Date ? audit.timestamp : new Date(),
  });
}

function requireHttpsLoopback(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error("allowlistResolution: UPDATE rejected: new URL is not parseable");
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (parsed.protocol !== "https:" && !loopback) {
    throw new Error("allowlistResolution: UPDATE rejected: new URL must use https (loopback exempt for tests)");
  }
  return target;
}

async function resolveUpdate({ models, reviewKey, url, newUrl, operator, reason, evidence, adapter, options = {} } = {}) {
  assertStagingModels(models);
  if (!adapter || typeof adapter.slug !== "string") {
    throw new Error("allowlistResolution: adapter with slug is required");
  }
  const provenance = requireProvenance({ operator, reason, evidence }, "UPDATE");
  if (typeof newUrl !== "string" || !newUrl.trim()) {
    throw new Error("allowlistResolution: UPDATE requires an explicit new URL (never inferred)");
  }
  const target = requireHttpsLoopback(newUrl.trim());

  const review = await models.ReviewState.findOne({ draftId: reviewKey }).lean();
  if (!review) {
    throw new Error(`allowlistResolution: unknown review "${reviewKey}"`);
  }
  const item = (review.items || []).find((entry) => entry && entry.field === `allowlist:${url}`);
  if (!item) {
    throw new Error(`allowlistResolution: review "${reviewKey}" has no item for ${url}`);
  }

  const doc = await loadDeclaration(models.AllowlistDeclaration, adapter);
  const prior = findResolution(doc, reviewKey, url);
  if (prior) {
    return { resolved: false, reason: "already resolved", existing: prior.toObject ? prior.toObject() : prior };
  }
  const known = new Set([...(doc.urls || []), ...(doc.retired || [])]);
  if (!known.has(url)) {
    throw new Error(`allowlistResolution: unknown declaration "${url}" (not effective and not retired)`);
  }

  // Validate through the existing probe + document gate: the exact new URL,
  // render-aware transport, acceptance required. No special paths.
  const probe = await probeAllowlistUrls({
    source: { sourceUrl: url, sourceDomain: hostOf(url), verificationStatus: "SOURCE_VERIFIED" },
    adapter: { ...adapter, bulletinUrls: [target] },
    options: {
      fetchDocument: options.fetchDocument,
      adapterDocRules: adapter.docRules,
      maxCandidates: 1,
    },
  });
  const acceptedEntry = probe.probed.find((entry) => entry.accepted);
  if (!acceptedEntry) {
    const first = probe.probed[0];
    throw new Error(
      `allowlistResolution: UPDATE rejected: new URL failed validation (${first ? first.reason : "unreachable"})`
    );
  }

  const next = [...doc.urls.filter((entry) => entry !== url)];
  if (!next.includes(target)) next.push(target);
  if (next.length > MAX_BULLETIN_URLS) {
    throw new Error("allowlistResolution: UPDATE rejected: resulting declaration exceeds the maximum bound");
  }

  const acceptedRaw = probe.accepted.find((raw) => raw.url === acceptedEntry.url) || probe.accepted[0] || null;
  const content = acceptedRaw && acceptedRaw.content;
  const baseline = {
    sourceUrl: target,
    documentUrl: (acceptedRaw && acceptedRaw.url) || target,
    contentHash: content && Buffer.isBuffer(content) ? sha256Hex(content) : null,
    revision: false,
    evidenceExcerpts: [],
    value: null,
  };
  doc.urls = next;
  if (!doc.retired.includes(url) && !next.includes(url)) doc.retired.push(url);
  const audit = {
    reviewId: reviewIdOf(reviewKey, url),
    candidateId: candidateIdOf(reviewKey),
    decision: "UPDATE",
    operator: provenance.operator,
    oldUrl: url,
    newUrl: target,
    reason: provenance.reason,
    evidence: provenance.evidence,
    timestamp: new Date(),
  };
  pushAudit(doc, audit);
  await doc.save();

  // Fresh baseline for the new declaration (same shape as surveillance
  // baselines); every prior history stays untouched in its own documents.
  let baselineDoc = await models.SurveillanceState.findOne({ candidateId: audit.candidateId, sourceUrl: target });
  if (!baselineDoc) {
    baselineDoc = new models.SurveillanceState({
      candidateId: audit.candidateId,
      sourceUrl: target,
      sourceDomain: hostOf(target),
      baseline,
      history: [{ checkedAt: new Date(), outcome: "BASELINE", triggers: [], snapshot: baseline }],
      lastOutcome: "BASELINE",
      reviewStateKey: null,
    });
    await baselineDoc.save();
  }
  return { resolved: true, declaration: doc.toObject(), baseline, audit };
}

async function resolveRetire({ models, reviewKey, url, operator, reason, evidence, adapter } = {}) {
  assertStagingModels(models);
  if (!adapter || typeof adapter.slug !== "string") {
    throw new Error("allowlistResolution: adapter with slug is required");
  }
  const provenance = requireProvenance({ operator, reason, evidence }, "RETIRE");

  const review = await models.ReviewState.findOne({ draftId: reviewKey }).lean();
  if (!review) {
    throw new Error(`allowlistResolution: unknown review "${reviewKey}"`);
  }
  const item = (review.items || []).find((entry) => entry && entry.field === `allowlist:${url}`);
  if (!item) {
    throw new Error(`allowlistResolution: review "${reviewKey}" has no item for ${url}`);
  }

  const doc = await loadDeclaration(models.AllowlistDeclaration, adapter);
  const prior = findResolution(doc, reviewKey, url);
  if (prior) {
    return { resolved: false, reason: "already resolved", existing: prior.toObject ? prior.toObject() : prior };
  }
  const known = new Set([...(doc.urls || []), ...(doc.retired || [])]);
  if (!known.has(url)) {
    throw new Error(`allowlistResolution: unknown declaration "${url}" (not effective and not retired)`);
  }

  doc.urls = (doc.urls || []).filter((entry) => entry !== url);
  if (!doc.retired.includes(url)) doc.retired.push(url);
  const audit = {
    reviewId: reviewIdOf(reviewKey, url),
    candidateId: candidateIdOf(reviewKey),
    decision: "RETIRE",
    operator: provenance.operator,
    oldUrl: url,
    newUrl: null,
    reason: provenance.reason,
    evidence: provenance.evidence,
    timestamp: new Date(),
  };
  pushAudit(doc, audit);
  await doc.save();
  // Surveillance history for every URL stays exactly as it was: retire only
  // edits this declaration record, so future freshness probes skip the URL
  // while all prior observations remain queryable.
  return { resolved: true, declaration: doc.toObject(), audit };
}

module.exports = {
  getEffectiveBulletinUrls,
  inspectFreshnessReview,
  resolveUpdate,
  resolveRetire,
};
