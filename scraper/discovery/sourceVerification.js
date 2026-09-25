// =============================================================================
// scraper/discovery/sourceVerification.js — STEP 3 source verification
// =============================================================================
// WHAT: Deterministic, evidence-preserving check of the source/domain
//   relationship behind a DISCOVERED candidate. Answers ONLY "does this domain
//   belong to the claimed conducting authority?" — never "is the exam itself
//   officially verified", never anything about dates/eligibility/content.
// WHY: Discovery finds candidates on seed pages; a seed listing is not proof
//   of authority. Verification compares the candidate against written-down
//   trusted configuration (explicit authority mappings + live-verified adapter
//   configs) and corroborates the conducting body. Anything short of the full
//   conjunction resolves to SOURCE_REVIEW_REQUIRED — guessing is a defect.
// DECISION (all three required for SOURCE_VERIFIED; every signal recorded):
//   1. exact-domain-trust: candidate domain exactly equals a trusted adapter's
//      official host or a configured authority domain (match) or not (unknown).
//      Substring/suffix resemblance is NOT a match.
//   2. conducting-body-match: candidate conductingBody normalizes to a mapped
//      body/alias (match); null body is unknown ("cannot corroborate"), never
//      assumed; a different body is mismatch (conflict).
//   3. https: source URL uses https (supporting) or not (mismatch).
// Supporting-only signals (recorded, never sufficient): gov-domain-heuristic
//   (.gov.in/.nic.in/.ac.in look — a look is not proof) and
//   seed-authority-context (being found via an authority seed explains the
//   sighting; it proves nothing about the domain and is discounted on purpose).
// CONTRACTS:
//   verifySource(candidateLike, { authorities, adapters })
//     -> { status: "SOURCE_VERIFIED"|"SOURCE_REVIEW_REQUIRED", reason,
//          signals: [{ signal, result, detail }], decidedAt } (pure).
//   applyVerification(ExamCandidate, SourceProfile, candidateId, options)
//     -> { candidate, profile, result } — persists verification + review flags
//        to scraper_source_profiles and advances DISCOVERED candidates only.
//        Re-verifying a decided candidate throws; no path leads to publishing.
// GENERICITY: no exam names, board names, or hosts anywhere in this file.
// =============================================================================

const { AUTHORITIES } = require("../registry/discovery/authorities");
const { EXAM_CANDIDATE_COLLECTION } = require("../models/examCandidate");
const { SOURCE_PROFILE_COLLECTION } = require("../models/sourceProfile");

const VERIFIER_TAG = "sourceVerification.v1";
const GOV_SUFFIXES = [".gov.in", ".nic.in", ".ac.in"];

// Conservative normalization: case + punctuation + parenthetical remarks are
// dropped ("National Testing Agency (NTA)" → "national testing agency"), so
// formal and short forms compare fairly against configured aliases.
function normalizeBody(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function trustedHosts(adapters) {
  const hosts = new Map(); // host -> [{ kind, ref, body }]
  for (const adapter of Array.isArray(adapters) ? adapters : []) {
    if (!adapter || typeof adapter.officialWebsite !== "string") continue;
    const host = hostOf(adapter.officialWebsite);
    if (!host) continue;
    if (!hosts.has(host)) hosts.set(host, []);
    hosts.get(host).push({
      kind: "adapter",
      ref: adapter.slug || "unknown-adapter",
      body: adapter.conductingBody || null,
    });
  }
  return hosts;
}

function verifySource(candidateLike, options = {}) {
  const candidate = candidateLike || {};
  const sourceUrl = typeof candidate.sourceUrl === "string" ? candidate.sourceUrl : "";
  const domain =
    typeof candidate.sourceDomain === "string" && candidate.sourceDomain
      ? candidate.sourceDomain.toLowerCase()
      : hostOf(sourceUrl);
  const authorities = Array.isArray(options.authorities) ? options.authorities : AUTHORITIES;
  const adapters = Array.isArray(options.adapters) ? options.adapters : [];
  const decidedAt = options.decidedAt instanceof Date ? options.decidedAt : new Date();
  const signals = [];

  // 1. Exact domain trust.
  const hosts = trustedHosts(adapters);
  const authorityHit = authorities.find(
    (entry) => Array.isArray(entry.domains) && entry.domains.some((d) => String(d).toLowerCase() === domain)
  );
  const adapterHits = hosts.get(domain) || [];
  const trustedRefs = [
    ...adapterHits.map((h) => ({ kind: h.kind, ref: h.ref, body: h.body })),
    ...(authorityHit
      ? [{ kind: "authority-mapping", ref: authorityHit.id, body: authorityHit.body, aliases: authorityHit.aliases || [] }]
      : []),
  ];
  signals.push({
    signal: "exact-domain-trust",
    result: trustedRefs.length > 0 ? "match" : "unknown",
    detail:
      trustedRefs.length > 0
        ? `domain "${domain}" is configured by ${trustedRefs.map((t) => `${t.kind}:${t.ref}`).join(", ")}`
        : `domain "${domain}" appears in no trusted adapter or authority mapping`,
  });

  // 2. Conducting-body corroboration.
  const claimed = typeof candidate.conductingBody === "string" ? candidate.conductingBody.trim() : null;
  const knownNames = [];
  for (const ref of trustedRefs) {
    if (ref.body) knownNames.push(ref.body);
    if (Array.isArray(ref.aliases)) knownNames.push(...ref.aliases);
  }
  const knownSet = new Set(knownNames.map(normalizeBody).filter(Boolean));
  if (!claimed) {
    signals.push({
      signal: "conducting-body-match",
      result: "unknown",
      detail: "candidate conducting body is missing — the domain relationship cannot be corroborated",
    });
  } else if (knownSet.size === 0) {
    signals.push({
      signal: "conducting-body-match",
      result: "unknown",
      detail: `claimed body "${claimed}" has no configured body to compare against for domain "${domain}"`,
    });
  } else if (knownSet.has(normalizeBody(claimed))) {
    signals.push({
      signal: "conducting-body-match",
      result: "match",
      detail: `claimed body "${claimed}" matches a configured body for domain "${domain}"`,
    });
  } else {
    signals.push({
      signal: "conducting-body-match",
      result: "mismatch",
      detail: `claimed body "${claimed}" conflicts with the configured body for domain "${domain}"`,
    });
  }

  // 3. Transport hygiene (supporting, never sufficient).
  const isHttps = sourceUrl.toLowerCase().startsWith("https://");
  signals.push({
    signal: "https",
    result: isHttps ? "supporting" : "mismatch",
    detail: isHttps ? "source URL uses https" : "source URL does not use https",
  });

  // Supporting-only context, explicitly discounted as proof.
  const govHit = GOV_SUFFIXES.some((suffix) => (domain || "").endsWith(suffix));
  signals.push({
    signal: "gov-domain-heuristic",
    result: govHit ? "supporting" : "unknown",
    detail: govHit
      ? `domain "${domain}" looks governmental — recorded as context only, never proof`
      : `domain "${domain}" carries no governmental marker`,
  });
  if (candidate.discoverySource) {
    signals.push({
      signal: "seed-authority-context",
      result: "supporting",
      detail: `sighted via seed "${candidate.discoverySource}" — explains the sighting, proves nothing about the domain`,
    });
  }

  const byName = Object.fromEntries(signals.map((s) => [s.signal, s.result]));
  const deficits = [];
  if (byName["exact-domain-trust"] !== "match") deficits.push("domain not in trusted configuration");
  if (byName["conducting-body-match"] !== "match") {
    deficits.push(
      byName["conducting-body-match"] === "mismatch" ? "conducting body conflicts" : "conducting body unknown"
    );
  }
  if (byName["https"] !== "supporting") deficits.push("not https");

  if (deficits.length === 0) {
    return {
      status: "SOURCE_VERIFIED",
      reason: `domain "${domain}" is configured for the claimed conducting body over https`,
      signals,
      decidedAt,
      decidedBy: VERIFIER_TAG,
    };
  }
  return {
    status: "SOURCE_REVIEW_REQUIRED",
    reason: `insufficient authority evidence: ${deficits.join("; ")}`,
    signals,
    decidedAt,
    decidedBy: VERIFIER_TAG,
  };
}

function assertCandidateModel(ExamCandidate) {
  if (!ExamCandidate || !ExamCandidate.collection) {
    throw new Error("sourceVerification: an exam-candidate model is required");
  }
  if (ExamCandidate.collection.name !== EXAM_CANDIDATE_COLLECTION) {
    throw new Error(
      `sourceVerification: refusing to operate on collection "${ExamCandidate.collection.name}" ` +
        `(candidates live in "${EXAM_CANDIDATE_COLLECTION}")`
    );
  }
}

function assertProfileModel(SourceProfile) {
  if (!SourceProfile || !SourceProfile.collection) {
    throw new Error("sourceVerification: a source-profile model is required");
  }
  if (SourceProfile.collection.name !== SOURCE_PROFILE_COLLECTION) {
    throw new Error(
      `sourceVerification: refusing to operate on collection "${SourceProfile.collection.name}" ` +
        `(profiles live in "${SOURCE_PROFILE_COLLECTION}")`
    );
  }
}

async function applyVerification(ExamCandidate, SourceProfile, candidateId, options = {}) {
  assertCandidateModel(ExamCandidate);
  assertProfileModel(SourceProfile);
  if (typeof candidateId !== "string" || !candidateId) {
    throw new Error("sourceVerification: candidateId is required");
  }
  const candidate = await ExamCandidate.findOne({ candidateId });
  if (!candidate) throw new Error(`sourceVerification: candidate not found: ${candidateId}`);
  if (candidate.status !== "DISCOVERED") {
    throw new Error(
      `sourceVerification: only DISCOVERED candidates may be verified (status is ${candidate.status})`
    );
  }

  const result = verifySource(candidate.toObject(), options);
  const needsReview = result.status === "SOURCE_REVIEW_REQUIRED";

  let profile = await SourceProfile.findOne({ candidateId });
  if (!profile) {
    profile = new SourceProfile({
      candidateId,
      sourceUrl: candidate.sourceUrl,
      sourceDomain: candidate.sourceDomain,
    });
  }
  profile.verification = {
    status: result.status,
    reason: result.reason,
    signals: result.signals,
    decidedAt: result.decidedAt,
    decidedBy: result.decidedBy,
  };
  profile.review = {
    required: needsReview,
    reasons: needsReview ? [result.reason] : [],
  };
  await profile.save();

  candidate.status = result.status;
  await candidate.save();

  return { candidate, profile, result };
}

module.exports = {
  VERIFIER_TAG,
  GOV_SUFFIXES,
  normalizeBody,
  verifySource,
  applyVerification,
};
