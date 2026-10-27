// =============================================================================
// scraper/discovery/openSerpProvider.js
// OpenSERP-backed exam-source discovery. Results only enter as DISCOVERED;
// ranking, snippets, HTTPS, and domain appearance are never verification proof.
// =============================================================================

const http = require("http");
const { candidateIdFor, extractYear, saveCandidates } = require("./examDiscovery");

const DEFAULT_BASE_URL = "http://127.0.0.1:7000";
const DEFAULT_QUERY_LIMIT = 5;
const DEFAULT_RESULTS_PER_QUERY = 5;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESULTS_PER_QUERY = 50;
const MAX_QUERY_LIMIT = 100;
const SOURCE_ID = "openserp";

function positiveInteger(value, fallback, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function readConfig(env = process.env) {
  const baseUrl = String(env.OPENSERP_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("OPENSERP_BASE_URL must be a valid HTTP URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("OPENSERP_BASE_URL must use HTTP or HTTPS");
  }
  const enabledValue = String(env.OPENSERP_ENABLED ?? "false").trim().toLowerCase();
  return {
    enabled: ["1", "true", "yes", "on"].includes(enabledValue),
    baseUrl: parsed.toString().replace(/\/$/, ""),
    queryLimit: positiveInteger(env.OPENSERP_QUERY_LIMIT, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT),
    resultsPerQuery: positiveInteger(env.OPENSERP_RESULTS_PER_QUERY, DEFAULT_RESULTS_PER_QUERY, MAX_RESULTS_PER_QUERY),
    timeoutMs: positiveInteger(env.OPENSERP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 60000),
  };
}

function requestJson(url, options = {}) {
  const client = url.protocol === "https:" ? require("https") : http;
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 60000);
  return new Promise((resolve, reject) => {
    const req = client.get(url, { headers: { Accept: "application/json" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) req.destroy(new Error("OpenSERP response exceeds 2 MiB"));
      });
      res.on("end", () => {
        if (res.statusCode === 429) {
          const error = new Error("OpenSERP rate limit response (HTTP 429)");
          error.code = "OPEN_SERP_RATE_LIMIT";
          reject(error);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`OpenSERP returned HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("OpenSERP returned malformed JSON"));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("OpenSERP request timed out")));
    req.on("error", reject);
  });
}

function resultsArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["results", "items", "data"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data && typeof payload.data === "object") {
    for (const key of ["results", "items"]) {
      if (Array.isArray(payload.data[key])) return payload.data[key];
    }
  }
  return [];
}

function normalizeResult(result, query, rank, discoveredAt) {
  if (!result || typeof result !== "object") return null;
  const title = String(result.title || result.name || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const rawUrl = result.url || result.link || result.href;
  if (!title || typeof rawUrl !== "string") return null;
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol) || !parsedUrl.hostname) return null;

  const snippet = [result.snippet, result.description, result.content]
    .find((value) => typeof value === "string") || null;
  const year = extractYear(`${title} ${rawUrl}`, "");
  const evidence = {
    seedId: SOURCE_ID,
    sourceUrl: parsedUrl.toString(),
    sourceTitle: title,
    matchedText: title,
    matchedUrl: parsedUrl.toString(),
    matchedPattern: "openserp-result",
    retrievedAt: discoveredAt,
    searchQuery: query,
    searchEngine: String(result.engine || result.search_engine || "duck").slice(0, 100),
    rank,
    snippet: snippet ? snippet.slice(0, 2000) : null,
    resultMetadata: result,
  };
  return {
    candidateId: candidateIdFor(title, year),
    name: title,
    description: snippet ? snippet.slice(0, 2000) : null,
    conductingBody: null,
    examUrl: parsedUrl.toString(),
    edition: year === null ? null : String(year),
    year,
    sourceUrl: parsedUrl.toString(),
    sourceDomain: parsedUrl.hostname.toLowerCase(),
    discoverySource: SOURCE_ID,
    discoveredAt,
    status: "DISCOVERED",
    evidence: [evidence],
  };
}

async function discoverFromOpenSerp(queries, options = {}) {
  const config = { ...readConfig(), ...(options.config || {}) };
  if (!config.enabled) return [];
  if (typeof config.baseUrl !== "string" || !/^https?:\/\//i.test(config.baseUrl)) {
    throw new Error("OpenSERP baseUrl must use HTTP or HTTPS");
  }
  config.queryLimit = positiveInteger(config.queryLimit, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
  config.resultsPerQuery = positiveInteger(config.resultsPerQuery, DEFAULT_RESULTS_PER_QUERY, MAX_RESULTS_PER_QUERY);
  const queryList = Array.isArray(queries)
    ? queries.map((query) => String(query || "").trim()).filter(Boolean).slice(0, config.queryLimit)
    : [];
  const request = options.requestJson || requestJson;
  const discoveredAt = options.discoveredAt instanceof Date
    ? options.discoveredAt
    : new Date(options.discoveredAt || Date.now());
  const deduped = new Map();

  for (const query of queryList) {
    try {
      const endpoint = new URL("/duck/search", `${config.baseUrl}/`);
      endpoint.searchParams.set("text", query);
      endpoint.searchParams.set("limit", String(config.resultsPerQuery));
      const payload = await request(endpoint, { timeoutMs: config.timeoutMs });
      const results = resultsArray(payload);
      for (let index = 0; index < results.length && index < config.resultsPerQuery; index += 1) {
        const candidate = normalizeResult(results[index], query, index + 1, discoveredAt);
        if (!candidate) continue;
        const urlKey = candidate.examUrl.toLowerCase().replace(/#.*$/, "");
        const key = `${candidate.candidateId}|${urlKey}`;
        if (!deduped.has(key)) deduped.set(key, candidate);
      }
    } catch (error) {
      if (typeof options.onError === "function") options.onError(error, query);
    }
  }
  return [...deduped.values()];
}

async function discoverAndSaveFromOpenSerp(ExamCandidate, queries, options = {}) {
  const candidates = await discoverFromOpenSerp(queries, options);
  const existing = candidates.length
    ? await ExamCandidate.find({ candidateId: { $in: candidates.map((candidate) => candidate.candidateId) } })
        .select("candidateId examUrl")
        .lean()
    : [];
  const knownIds = new Set(existing.map((candidate) => candidate.candidateId));
  const knownUrls = new Set(existing.map((candidate) => String(candidate.examUrl || "").toLowerCase().replace(/#.*$/, "")));
  const fresh = candidates.filter((candidate) => {
    const urlKey = candidate.examUrl.toLowerCase().replace(/#.*$/, "");
    if (knownIds.has(candidate.candidateId) || knownUrls.has(urlKey)) return false;
    knownIds.add(candidate.candidateId);
    knownUrls.add(urlKey);
    return true;
  });
  if (fresh.length === 0) return { candidates: [], created: [], reused: [] };
  const saved = await saveCandidates(ExamCandidate, fresh);
  return { candidates: fresh, ...saved };
}

async function discoverVerifyAndProfileFromOpenSerp(ExamCandidate, SourceProfile, queries, options = {}) {
  const saved = await discoverAndSaveFromOpenSerp(ExamCandidate, queries, options);
  const { applyVerification } = require("./sourceVerification");
  const { profileCandidate } = require("./sourceProfiler");
  const processed = [];
  for (const candidateId of saved.created) {
    const verification = await applyVerification(
      ExamCandidate,
      SourceProfile,
      candidateId,
      options.verificationOptions || {}
    );
    const technicalProfile = profileCandidate(verification.candidate.toObject(), {
      adapters: options.adapters || [],
    });
    verification.profile.profile = {
      type: technicalProfile.type,
      transport: technicalProfile.transport,
      documentTypes: technicalProfile.documentTypes,
      requiresJavaScript: technicalProfile.requiresJavaScript,
      signals: technicalProfile.signals,
      profiledAt: options.discoveredAt instanceof Date ? options.discoveredAt : new Date(),
      profiler: technicalProfile.profiler,
    };
    await verification.profile.save();
    processed.push({ candidate: verification.candidate, profile: verification.profile });
  }
  return { ...saved, processed };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_QUERY_LIMIT,
  DEFAULT_RESULTS_PER_QUERY,
  readConfig,
  requestJson,
  resultsArray,
  normalizeResult,
  discoverFromOpenSerp,
  discoverAndSaveFromOpenSerp,
  discoverVerifyAndProfileFromOpenSerp,
};
