// =============================================================================
// scraper/discovery/examDiscovery.js — STEP 2 automated exam discovery
// =============================================================================
// WHAT: Generic, deterministic discovery of candidate exams from configured
//   seeds. Reads a seed page (links + title via parsers/htmlParser), matches
//   link text against the seed's own include/exclude patterns, and emits
//   DISCOVERED candidates with evidence. Stops at DISCOVERED — no crawling of
//   candidates, no extraction of dates/eligibility, no verification, no
//   publishing (those are later steps with their own modules and tests).
// WHY: NextStep must find exams it was never told about. Discovery answers
//   "what might exist?" while verification later answers "is it official?"
//   Collapsing those two questions is how scrapers publish garbage.
// GENERICITY: no exam names, no board names, no per-exam branches anywhere in
//   this file. All signals (patterns, caps) come from the seed config
//   (registry/discovery/seeds.js); year detection is a plain 4-digit year.
// CONTRACTS:
//   discoverCandidatesFromHtml(seed, html, { sourceUrl, retrievedAt })
//     -> [{ candidateId, name, description, conductingBody, examUrl, edition,
//           year, sourceUrl, sourceDomain, discoverySource, discoveredAt,
//           status: "DISCOVERED", evidence[] }] (pure: no I/O, no DB).
//   discoverFromSeed(seed, { fetchHtml, retrievedAt })
//     -> same shape (fetchHtml defaults to fetchers/httpFetcher.fetchHTML;
//       inject a stub in tests; never requires Crawlee or network by itself).
//   saveCandidates(ExamCandidate, candidates)
//     -> { created: [ids], reused: [ids] } — upsert by candidateId: a
//        re-sighted candidate appends unseen evidence + discoverySources and
//        bumps lastSeenAt instead of duplicating; nothing is ever overwritten.
//   transitionCandidateStatus(ExamCandidate, id, target)
//     -> Step 2 allows only the DISCOVERED no-op; any forward transition
//        throws (verification workflow lands in Step 3).
// IDENTITY: candidateId = "dsc-" + sha256(normalizedName|yearOrUnknown)[0:16].
//   Normalization is deliberately light (case/whitespace/punctuation) so
//   distinct exams never collapse; the year keeps editions distinguishable.
//   Source identity lives in evidence/discoverySources, not in the id, so the
//   same exam sighted from two seeds reuses one candidate with both sightings
//   preserved.
// =============================================================================

const crypto = require("crypto");

const parseHTML = require("../parsers/htmlParser");
const { resolveUrl } = require("../fetchers/httpFetcher");
const { DiscoverySeedSchema } = require("../registry/discovery/seeds");
const { EXAM_CANDIDATE_COLLECTION } = require("../models/examCandidate");

const MAX_NAME_CHARS = 200;
const YEAR_RE = /(19|20)\d{2}/;

function assertCandidateModel(ExamCandidate) {
  if (!ExamCandidate || !ExamCandidate.collection) {
    throw new Error("examDiscovery: an exam-candidate model is required");
  }
  if (ExamCandidate.collection.name !== EXAM_CANDIDATE_COLLECTION) {
    throw new Error(
      `examDiscovery: refusing to operate on collection "${ExamCandidate.collection.name}" ` +
        `(candidates live in "${EXAM_CANDIDATE_COLLECTION}")`
    );
  }
}

function sourceDomainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (error) {
    throw new Error(`examDiscovery: invalid source URL "${url}": ${error.message}`);
  }
}

function compileRules(seed) {
  const rules = (seed && seed.rules) || {};
  const include = (Array.isArray(rules.includePatterns) ? rules.includePatterns : []).map(
    (source) => ({ source, re: new RegExp(source, "i") })
  );
  const exclude = (Array.isArray(rules.excludePatterns) ? rules.excludePatterns : []).map(
    (source) => new RegExp(source, "i")
  );
  const maxCandidates =
    typeof rules.maxCandidates === "number" && rules.maxCandidates >= 1
      ? Math.floor(rules.maxCandidates)
      : 50;
  return { include, exclude, maxCandidates };
}

// Light normalization only: case + whitespace + punctuation. Never stems,
// never drops tokens — "JEE Main" and "JEE Advanced" must stay apart.
function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

function extractYear(text, url) {
  const haystack = `${text || ""} ${url || ""}`;
  const hit = haystack.match(YEAR_RE);
  return hit ? parseInt(hit[0], 10) : null;
}

function candidateIdFor(name, year) {
  const digest = crypto
    .createHash("sha256")
    .update(`${normalizeName(name)}|${year === null || year === undefined ? "unknown" : String(year)}`)
    .digest("hex")
    .slice(0, 16);
  return `dsc-${digest}`;
}

function cleanName(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
}

function discoverCandidatesFromHtml(seed, html, options = {}) {
  const parsed = DiscoverySeedSchema.parse(seed);
  const sourceUrl = options.sourceUrl || parsed.url;
  const retrievedAt = options.retrievedAt instanceof Date ? options.retrievedAt : new Date(options.retrievedAt || Date.now());
  const sourceDomain = sourceDomainOf(sourceUrl);
  const { include, exclude, maxCandidates } = compileRules(parsed);

  const data = parseHTML(String(html || ""));
  const byId = new Map();

  for (const link of data.links || []) {
    if (!link || typeof link.text !== "string" || typeof link.url !== "string") continue;
    const text = cleanName(link.text);
    if (text.length < 3) continue;
    const matched = include.find((pattern) => pattern.re.test(text));
    if (!matched) continue;
    if (exclude.some((re) => re.test(text))) continue;

    let examUrl = null;
    try {
      examUrl = resolveUrl(link.url, sourceUrl);
    } catch {
      examUrl = null;
    }

    const year = extractYear(text, examUrl || link.url);
    const candidateId = candidateIdFor(text, year);
    const evidence = {
      seedId: parsed.id,
      sourceUrl,
      sourceTitle: data.title || null,
      matchedText: text,
      matchedUrl: examUrl,
      matchedPattern: matched.source,
      retrievedAt,
    };

    const existing = byId.get(candidateId);
    if (existing) {
      if (!existing.evidence.some((e) => e.matchedUrl === evidence.matchedUrl && e.matchedText === evidence.matchedText)) {
        existing.evidence.push(evidence);
      }
      continue;
    }
    byId.set(candidateId, {
      candidateId,
      name: text,
      description: null,
      conductingBody: null,
      examUrl,
      edition: year === null ? null : String(year),
      year,
      sourceUrl,
      sourceDomain,
      discoverySource: parsed.id,
      discoveredAt: retrievedAt,
      status: "DISCOVERED",
      evidence: [evidence],
    });
    if (byId.size >= maxCandidates) break;
  }

  return [...byId.values()];
}

async function discoverFromSeed(seed, options = {}) {
  const parsed = DiscoverySeedSchema.parse(seed);
  if (parsed.enabled === false) return [];
  const fetchHtml =
    typeof options.fetchHtml === "function" ? options.fetchHtml : require("../fetchers/httpFetcher").fetchHTML;
  const retrievedAt =
    options.retrievedAt instanceof Date ? options.retrievedAt : new Date(options.retrievedAt || Date.now());
  const page = await fetchHtml(parsed.url);
  return discoverCandidatesFromHtml(parsed, page.text, {
    sourceUrl: (page && page.url) || parsed.url,
    retrievedAt,
  });
}

function mergeEvidence(stored, incoming) {
  const seen = new Set(
    (stored.evidence || []).map((e) => `${e.seedId}|${e.matchedUrl}|${e.matchedText}`)
  );
  let added = false;
  for (const entry of incoming.evidence || []) {
    const key = `${entry.seedId}|${entry.matchedUrl}|${entry.matchedText}`;
    if (!seen.has(key)) {
      stored.evidence.push(entry);
      seen.add(key);
      added = true;
    }
  }
  const sources = new Set(stored.discoverySources || []);
  if (incoming.discoverySource && !sources.has(incoming.discoverySource)) {
    stored.discoverySources.push(incoming.discoverySource);
    added = true;
  }
  if (incoming.sourceUrl && incoming.sourceUrl !== stored.sourceUrl) {
    // Keep the first-seen sourceUrl as the stable anchor; later sightings
    // remain fully traceable through evidence + discoverySources.
  }
  stored.lastSeenAt = incoming.discoveredAt;
  return added;
}

async function saveCandidates(ExamCandidate, candidates) {
  assertCandidateModel(ExamCandidate);
  const list = Array.isArray(candidates) ? candidates : [];
  const created = [];
  const reused = [];
  for (const candidate of list) {
    if (!candidate || typeof candidate.candidateId !== "string") {
      throw new Error("examDiscovery: candidate with candidateId is required");
    }
    const existing = await ExamCandidate.findOne({ candidateId: candidate.candidateId });
    if (!existing) {
      await ExamCandidate.create({
        candidateId: candidate.candidateId,
        name: candidate.name,
        description: candidate.description ?? null,
        conductingBody: candidate.conductingBody ?? null,
        examUrl: candidate.examUrl ?? null,
        edition: candidate.edition ?? null,
        year: candidate.year ?? null,
        sourceUrl: candidate.sourceUrl,
        sourceDomain: candidate.sourceDomain,
        discoverySource: candidate.discoverySource,
        discoverySources: [candidate.discoverySource],
        discoveredAt: candidate.discoveredAt,
        lastSeenAt: candidate.discoveredAt,
        status: "DISCOVERED",
        evidence: candidate.evidence || [],
      });
      created.push(candidate.candidateId);
      continue;
    }
    mergeEvidence(existing, candidate);
    await existing.save();
    reused.push(candidate.candidateId);
  }
  return { created, reused };
}

// Step 2 allows no forward motion: DISCOVERED is the terminal state of this
// step. Verification transitions arrive with Step 3; until then any attempt
// to leave DISCOVERED fails loudly instead of silently promoting.
async function transitionCandidateStatus(ExamCandidate, candidateId, target) {
  assertCandidateModel(ExamCandidate);
  if (target === "DISCOVERED") {
    const existing = await ExamCandidate.findOne({ candidateId });
    if (!existing) throw new Error(`examDiscovery: candidate not found: ${candidateId}`);
    return existing;
  }
  throw new Error(
    `examDiscovery: status transition to "${target}" is not implemented ` +
      `(candidates stay DISCOVERED until source verification lands)`
  );
}

module.exports = {
  MAX_NAME_CHARS,
  normalizeName,
  extractYear,
  candidateIdFor,
  sourceDomainOf,
  discoverCandidatesFromHtml,
  discoverFromSeed,
  saveCandidates,
  transitionCandidateStatus,
};
