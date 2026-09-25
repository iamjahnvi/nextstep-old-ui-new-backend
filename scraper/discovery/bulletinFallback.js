// =============================================================================
// scraper/discovery/bulletinFallback.js — STEP 21 observed bulletin fallback
// =============================================================================
// WHAT: Bounded fallback probe for when normal discovery on a render "js"
//   source yields no bulletin/adapter-matched document (e.g. the bulletin
//   link is unlabeled, script-rendered, or worded outside the scoring
//   vocabulary). It re-examines links OBSERVED in fetched page HTML, ranks
//   same-domain PDF URLs and adapter-rule-matching URLs deterministically,
//   probes at most maxCandidates of them through the existing render-aware
//   transport, and accepts only reachable, valid documents.
// WHY: A js landing can be perfectly accessible while its bulletin link
//   escapes scoring. The fallback closes exactly that gap — observed URLs
//   only, never constructed paths, never broad guessing, never a second
//   crawler. Static adapters never trigger it (their flow is byte-identical).
// CANDIDATE SOURCES (evidence-backed only, in rank order):
//   0. adapter docRule hit (match text / matchUrl stem — existing adapter
//      configuration, same substring semantics as sourceDiscovery).
//   1. bulletin keyword in the URL (CATEGORY_KEYWORDS.BULLETIN — the same
//      vocabulary discovery uses, not new phrases).
//   2. any other same-domain PDF link observed on the page.
//   Non-PDF links without an adapter hit are never candidates (a bulletin is
//   a document; anything else would be guessing). Boilerplate, off-domain,
//   non-http(s), and already-discovered URLs are excluded up front.
// CONTRACTS:
//   needsBulletinFallback(documents, adapter) -> boolean.
//     True only when adapter.render === "js" AND no discovered document
//     carries label BULLETIN or an adapter-docrule signal. Static adapters
//     (or missing adapters) always return false.
//   deriveBulletinCandidates({ links, pageUrl, sourceDomain, adapterDocRules,
//     knownUrls?, maxCandidates? }) -> [{ url, derivedFrom, pattern, rank,
//     evidence }] — pure, deterministic (rank, then url). Bounded.
//   probeBulletinFallback({ source, adapter, options? })
//     options: { fetchPage?, fetchDocument?, knownUrls?, maxCandidates?,
//                discoveredAt? } — re-fetches ONLY the source landing page
//                through the render-aware selector (one bounded fetch), then
//                probes candidates through fetchDocumentForAdapter.
//     -> { probed: [{ url, derivedFrom, pattern, reachable, accepted,
//          reason, bytes?, contentType?, label? }], accepted: [RawDocument] }.
//        Acceptance requires success PLUS document validity: PDFs need
//        non-empty bytes with %PDF magic or a pdf content-type; HTML needs an
//        adapter-rule hit on its final URL. Failures are recorded per
//        candidate and never throw.
//   DEFAULT_MAX_CANDIDATES = 3.
// GENERICITY: render flag + adapter config + observed URLs only. No exam
//   names, no constructed paths, no per-source branches.
// =============================================================================

const parseHTML = require("../parsers/htmlParser");
const { resolveUrl } = require("../fetchers/httpFetcher");
const {
  CATEGORY_KEYWORDS,
  adapterRuleHits,
  hostOf,
  normalizeUrl,
  inferDocumentType,
  isBoilerplate,
} = require("./documentDiscovery");
const { fetchPageForAdapter, fetchDocumentForAdapter } = require("../fetchers/transportSelector");

const DEFAULT_MAX_CANDIDATES = 3;
const PDF_MAGIC = "%PDF";

function hasAdapterRuleSignal(doc) {
  return (
    doc &&
    Array.isArray(doc.matchedSignals) &&
    doc.matchedSignals.some(
      (entry) => entry && typeof entry.signal === "string" && entry.signal.startsWith("adapter-docrule:")
    )
  );
}

function needsBulletinFallback(documents, adapter) {
  if (!adapter || adapter.render !== "js") return false;
  const docs = Array.isArray(documents) ? documents : [];
  return !docs.some((doc) => doc && (doc.label === "BULLETIN" || hasAdapterRuleSignal(doc)));
}

function bulletinUrlKeyword(urlLower) {
  const phrases = [...(CATEGORY_KEYWORDS.BULLETIN || [])].sort((a, b) => b.length - a.length);
  return phrases.find((phrase) => urlLower.includes(phrase)) || null;
}

function deriveBulletinCandidates(input = {}) {
  const {
    links,
    pageUrl,
    sourceDomain,
    adapterDocRules,
    knownUrls,
    maxCandidates,
  } = input;
  if (typeof pageUrl !== "string" || !pageUrl) {
    throw new Error("bulletinFallback: pageUrl is required");
  }
  const domain = sourceDomain || hostOf(pageUrl);
  const limit =
    typeof maxCandidates === "number" && maxCandidates >= 1 ? Math.floor(maxCandidates) : DEFAULT_MAX_CANDIDATES;
  const known = new Set(
    (Array.isArray(knownUrls) ? knownUrls : []).map((url) => {
      try {
        return normalizeUrl(String(url));
      } catch {
        return String(url);
      }
    })
  );
  const ranked = [];
  for (const link of Array.isArray(links) ? links : []) {
    if (!link || typeof link.url !== "string") continue;
    const raw = link.url.trim();
    if (/^(mailto:|javascript:|#|tel:)/i.test(raw)) continue;
    let resolved;
    try {
      resolved = resolveUrl(raw, pageUrl);
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(resolved)) continue;
    if (hostOf(resolved) !== domain) continue;
    const key = normalizeUrl(resolved);
    if (known.has(key)) continue;
    const text = String(link.text || "").replace(/\s+/g, " ").trim();
    if (isBoilerplate(text, resolved)) continue;
    const isPdf = inferDocumentType(resolved) === "PDF";
    const ruleHits = adapterRuleHits(text, resolved, adapterDocRules);
    const keyword = bulletinUrlKeyword(resolved.toLowerCase());
    if (!isPdf && ruleHits.length === 0) continue;
    const rank = ruleHits.length > 0 ? 0 : keyword ? 1 : 2;
    ranked.push({
      url: resolved,
      derivedFrom: "page-link",
      pattern:
        ruleHits.length > 0
          ? `adapter-docrule:${ruleHits[0]}`
          : keyword
            ? `url-keyword:${keyword}`
            : "page-pdf-link",
      rank,
      evidence: {
        observedOn: pageUrl,
        linkText: text || null,
        matchedRule: ruleHits.length > 0 ? ruleHits[0] : null,
      },
    });
  }
  ranked.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const seen = new Set();
  return ranked
    .filter((candidate) => {
      if (seen.has(candidate.url)) return false;
      seen.add(candidate.url);
      return true;
    })
    .slice(0, limit);
}

function validPdfContent(content, contentType) {
  if (!Buffer.isBuffer(content) || content.length === 0) return false;
  if (String(contentType || "").toLowerCase().includes("pdf")) return true;
  return content.slice(0, 4).toString("latin1") === PDF_MAGIC;
}

// Shared acceptance gate for probed documents (observed-link and allowlist
// candidates alike): reachable alone is never enough. PDFs need valid bytes;
// HTML needs an adapter-rule hit on its final URL. Returns { accepted,
// reason, label } without throwing.
function validateProbedDocument(raw, candidate, adapterDocRules) {
  const finalUrl = String((raw && raw.url) || (candidate && candidate.url) || "");
  const isPdf = (raw && raw.type === "PDF") || inferDocumentType(finalUrl) === "PDF";
  const linkText =
    (candidate && candidate.evidence && candidate.evidence.linkText) || "";
  const ruleHits = adapterRuleHits(linkText, finalUrl, adapterDocRules);
  if (isPdf) {
    if (!validPdfContent(raw && raw.content, raw && raw.contentType)) {
      return { accepted: false, reason: "fetched bytes are not a valid PDF", label: null };
    }
  } else if (
    ruleHits.length === 0 ||
    typeof (raw && raw.content) !== "string" ||
    raw.content.length === 0
  ) {
    return { accepted: false, reason: "HTML without adapter-rule confirmation", label: null };
  }
  return {
    accepted: true,
    reason: "reachable and passes document identification",
    label: ruleHits.length > 0 ? `adapter:${ruleHits[0]}` : "bulletin",
  };
}

async function probeBulletinFallback({ source, adapter, options = {} } = {}) {
  if (!source || typeof source.sourceUrl !== "string") {
    throw new Error("bulletinFallback: source with sourceUrl is required");
  }
  const limit =
    typeof options.maxCandidates === "number" && options.maxCandidates >= 1
      ? Math.floor(options.maxCandidates)
      : DEFAULT_MAX_CANDIDATES;
  const probed = [];
  const accepted = [];

  const fetchPage =
    typeof options.fetchPage === "function"
      ? options.fetchPage
      : async (url) => {
          const page = await fetchPageForAdapter(url, adapter);
          return { url: page.url, text: page.text };
        };
  const fetchVia =
    typeof options.fetchDocument === "function"
      ? options.fetchDocument
      : async (meta) => fetchDocumentForAdapter(meta, adapter);

  let page;
  try {
    page = await fetchPage(source.sourceUrl);
  } catch (error) {
    return {
      probed,
      accepted,
      error: `landing re-fetch failed: ${error.message}`,
    };
  }
  if (!page || typeof page.text !== "string") {
    return { probed, accepted, error: "landing re-fetch returned no text" };
  }
  const pageUrl = page.url || source.sourceUrl;
  const data = parseHTML(page.text);
  const candidates = deriveBulletinCandidates({
    links: data.links,
    pageUrl,
    sourceDomain: source.sourceDomain || hostOf(source.sourceUrl),
    adapterDocRules: options.adapterDocRules || (adapter && adapter.docRules),
    knownUrls: options.knownUrls,
    maxCandidates: limit,
  });

  for (const candidate of candidates) {
    const entry = {
      url: candidate.url,
      derivedFrom: candidate.derivedFrom,
      pattern: candidate.pattern,
      reachable: false,
      accepted: false,
      reason: null,
      bytes: null,
      contentType: null,
      label: null,
    };
    try {
      const raw = await fetchVia({
        label: candidate.evidence.linkText || "bulletin-fallback",
        url: candidate.url,
        sourceUrl: pageUrl,
        type: inferDocumentType(candidate.url),
      });
      entry.reachable = true;
      entry.contentType = raw.contentType || null;
      const verdict = validateProbedDocument(
        raw,
        candidate,
        options.adapterDocRules || (adapter && adapter.docRules)
      );
      entry.accepted = verdict.accepted;
      entry.reason = verdict.reason;
      if (verdict.accepted) {
        entry.label = verdict.label;
        entry.bytes = Buffer.isBuffer(raw.content) ? raw.content.length : String(raw.content).length;
        accepted.push({ ...raw, label: entry.label });
      }
    } catch (error) {
      entry.reason = `fetch failed: ${error.message}`;
    }
    probed.push(entry);
  }

  return { probed, accepted };
}

// ---------------------------------------------------------------------------
// STEP 22 adapter-declared URL allowlist.
//
// Precedence: normal discovery → Step 21 observed-link fallback → this
// allowlist, and only while no bulletin/adapter-matched document has been
// found yet. Each declared URL is probed exactly as written through the
// render-aware transport (Step 20: static → HTTP, js → pooled browser with
// download capture) and validated by the same gate as observed candidates.
// Declaration is explicit operator trust, so an allowlisted URL is exempt
// from the same-domain restriction — but it must still be https, reachable,
// and a valid document. Anything else is recorded and skipped.

function declaredAllowlist(adapter) {
  const urls = adapter && Array.isArray(adapter.bulletinUrls) ? adapter.bulletinUrls : [];
  return urls.filter((url) => typeof url === "string" && url.trim() !== "");
}

function needsAllowlistProbe({ documents, fallbackAccepted, adapter } = {}) {
  const urls = declaredAllowlist(adapter);
  if (urls.length === 0) return false;
  const docs = Array.isArray(documents) ? documents : [];
  const found = docs.some((doc) => doc && (doc.label === "BULLETIN" || hasAdapterRuleSignal(doc)));
  if (found) return false;
  const accepted = Array.isArray(fallbackAccepted) ? fallbackAccepted : [];
  if (accepted.length > 0) return false;
  return true;
}

async function probeAllowlistUrls({ source, adapter, options = {} } = {}) {
  if (!source || typeof source.sourceUrl !== "string") {
    throw new Error("bulletinFallback: source with sourceUrl is required");
  }
  const { MAX_BULLETIN_URLS } = require("../registry/schema");
  const declared = declaredAllowlist(adapter).slice(0, MAX_BULLETIN_URLS);
  const limit =
    typeof options.maxCandidates === "number" && options.maxCandidates >= 1
      ? Math.min(Math.floor(options.maxCandidates), MAX_BULLETIN_URLS)
      : Math.min(declared.length, MAX_BULLETIN_URLS);
  const probed = [];
  const accepted = [];

  const fetchVia =
    typeof options.fetchDocument === "function"
      ? options.fetchDocument
      : async (meta) => fetchDocumentForAdapter(meta, adapter);

  for (const url of declared.slice(0, limit)) {
    const entry = {
      url,
      derivedFrom: "adapter-allowlist",
      pattern: "exact-declared-url",
      reachable: false,
      accepted: false,
      reason: null,
      bytes: null,
      contentType: null,
      label: null,
      documentType: inferDocumentType(url),
    };
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      entry.reason = "declared URL is not parseable";
      probed.push(entry);
      continue;
    }
    // Explicit trust still requires transport safety: cleartext only to
    // loopback (local testing), https everywhere else.
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (parsed.protocol !== "https:" && !isLoopback) {
      entry.reason = "allowlisted URLs must use https (loopback exempt for tests)";
      probed.push(entry);
      continue;
    }
    try {
      const raw = await fetchVia({
        label: "bulletin-allowlist",
        url,
        sourceUrl: source.sourceUrl,
        type: entry.documentType,
      });
      entry.reachable = true;
      entry.contentType = raw.contentType || null;
      const verdict = validateProbedDocument(
        raw,
        { url, evidence: { linkText: "" } },
        options.adapterDocRules || (adapter && adapter.docRules)
      );
      entry.accepted = verdict.accepted;
      entry.reason = verdict.reason;
      if (verdict.accepted) {
        entry.label = verdict.label;
        entry.bytes = Buffer.isBuffer(raw.content) ? raw.content.length : String(raw.content).length;
        accepted.push({ ...raw, label: entry.label });
      }
    } catch (error) {
      entry.reason = `fetch failed: ${error.message}`;
    }
    probed.push(entry);
  }

  return { probed, accepted };
}

module.exports = {
  DEFAULT_MAX_CANDIDATES,
  needsBulletinFallback,
  deriveBulletinCandidates,
  probeBulletinFallback,
  needsAllowlistProbe,
  probeAllowlistUrls,
};
