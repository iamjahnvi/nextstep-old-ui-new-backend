// =============================================================================
// scraper/discovery/documentDiscovery.js — STEP 4 broader document discovery
// =============================================================================
// WHAT: Generic, deterministic discovery of relevant official pages/documents
//   for a SOURCE_VERIFIED source. From supplied pages (or a bounded traversal
//   over an injected page fetcher), it scores every same-domain link against
//   category keyword signals and returns a RANKED list of document candidates
//   with evidence — never bare URLs, never content understanding.
// WHY: The important material is rarely all on the landing page: bulletins,
//   revised bulletins, corrigenda, schedules, and syllabi must each stay
//   separately discoverable so later processing can decide authoritativeness.
//   First-match-wins (discovery/sourceDiscovery.js) would collapse revisions;
//   this layer preserves every qualifying link instead.
// CATEGORIES: BULLETIN | NOTIFICATION | CORRIGENDUM | REGISTRATION |
//   ELIGIBILITY | SYLLABUS | EXAM_PATTERN | IMPORTANT_DATES | APPLICATION |
//   RESULT | OTHER.
// SCORING (deterministic, weights fixed here — generic words, never exams):
//   link-text phrase hit +3 · resolved-URL phrase hit +2 · revision marker
//   (revised/corrigendum/updated/addendum/errata/extended) +1 bonus ·
//   adapter-docRule hit (same match/matchUrl substring semantics as
//   sourceDiscovery) +2 · boilerplate (login/contact/sitemap/social/...) -10
//   and dropped. Threshold: score >= 2 keeps; best-scoring category wins
//   (ties resolve in CATEGORY_PRIORITY order); score 2 with no specific
//   category becomes OTHER (relevant-by-config, e.g. an adapter URL stem).
// BOUNDS (no uncontrolled crawling): maxDepth (default 1) · maxPages
//   (default 5) · maxDocuments (default 50) · sameDomainOnly (default true).
//   Traversal follows only relevant, non-PDF, same-domain links. Output is
//   sorted by relevanceScore desc, then url asc — fully deterministic.
// CONTRACTS:
//   discoverDocumentsFromPages(source, pages, options)
//     source  : { sourceUrl, sourceDomain?, verificationStatus } — must carry
//               verificationStatus "SOURCE_VERIFIED" or it throws.
//     pages   : [{ url, html, depth? }] — already-held page samples.
//     options : { adapterDocRules?, maxDocuments?, discoveredAt? }.
//     -> { documents: [{ url, sourceUrl, label, title, documentType,
//          relevanceScore, matchedSignals, discoveredAt, depth }], stats }.
//        Pure: no I/O, no network. Finds documents; understands nothing.
//   discoverFromSource(source, options)
//     options : { fetchPage?, adapter?, maxDepth?, maxPages?, maxDocuments?,
//               adapterDocRules?, discoveredAt? } — fetchPage defaults to the
//               render-aware selector (fetchers/transportSelector): static (or
//               no adapter) uses the existing httpFetcher, render "js" uses
//               the existing pooled-browser transport; an explicit fetchPage
//               always wins. Returns pages as { url, text }. Inject a stub in
//               tests. Bounded BFS from source.sourceUrl (depth 0).
//   Discovered documents are NOT authority-verified: discovery ranks
//   relevance; verification of each document belongs to later steps.
// GENERICITY: no exam names, board names, or hosts anywhere in this file.
// =============================================================================

const parseHTML = require("../parsers/htmlParser");
const { resolveUrl } = require("../fetchers/httpFetcher");

const DOCUMENT_CATEGORIES = [
  "BULLETIN",
  "NOTIFICATION",
  "CORRIGENDUM",
  "REGISTRATION",
  "ELIGIBILITY",
  "SYLLABUS",
  "EXAM_PATTERN",
  "IMPORTANT_DATES",
  "APPLICATION",
  "RESULT",
  "OTHER",
];

// Tie-break order when two categories score equally (most specific first).
const CATEGORY_PRIORITY = [
  "CORRIGENDUM",
  "BULLETIN",
  "IMPORTANT_DATES",
  "REGISTRATION",
  "ELIGIBILITY",
  "SYLLABUS",
  "EXAM_PATTERN",
  "APPLICATION",
  "NOTIFICATION",
  "RESULT",
  "OTHER",
];

// Generic category signals. Multi-word (specific) phrases precede single words
// so the recorded matchedSignal names the most informative phrase.
const CATEGORY_KEYWORDS = {
  BULLETIN: ["information bulletin", "bulletin", "brochure", "prospectus", "information brochure"],
  NOTIFICATION: ["notification", "notice", "announcement", "press release", "advertisement"],
  CORRIGENDUM: ["corrigendum", "errata", "addendum"],
  REGISTRATION: ["registration", "apply online", "online application", "application form"],
  ELIGIBILITY: ["eligibility", "eligibility criteria"],
  SYLLABUS: ["syllabus", "syllabi"],
  EXAM_PATTERN: ["exam pattern", "paper pattern", "exam scheme", "scheme of examination"],
  IMPORTANT_DATES: ["important dates", "schedule", "date sheet", "time table", "calendar"],
  APPLICATION: ["application", "apply"],
  RESULT: ["result", "merit list", "cut off", "cutoff", "scorecard"],
  OTHER: [],
};

// Revision markers add a bonus wherever they appear (a revised bulletin must
// outrank its original deterministically) and feed CORRIGENDUM candidacy.
const REVISION_MARKERS = ["revised", "corrigendum", "updated", "addendum", "errata", "extended"];

// Boilerplate / chrome: excluded no matter the score.
const BOILERPLATE_RES = [
  /\blog\s?in\b/i,
  /\bsign\s?in\b/i,
  /\bcontact\s?us\b/i,
  /\bsitemap\b/i,
  /\bprivacy\b/i,
  /\bterms\b/i,
  /\btender\b/i,
  /\bfacebook\b/i,
  /\btwitter\b/i,
  /\byoutube\b/i,
  /\binstagram\b/i,
  /\blinkedin\b/i,
];

const TEXT_WEIGHT = 3;
const URL_WEIGHT = 2;
const REVISION_BONUS = 1;
const ADAPTER_RULE_WEIGHT = 2;
const SCORE_THRESHOLD = 2;
const PDF_URL_RE = /\.pdf([?#]|$)/i;

function assertVerifiedSource(source) {
  if (!source || typeof source.sourceUrl !== "string") {
    throw new Error("documentDiscovery: source with sourceUrl is required");
  }
  if (source.verificationStatus !== "SOURCE_VERIFIED") {
    throw new Error(
      `documentDiscovery: refusing to process source with status "${source.verificationStatus || "unknown"}" ` +
        `(only SOURCE_VERIFIED sources are discoverable)`
    );
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    let text = parsed.toString();
    if (text.endsWith("/") && parsed.pathname === "/") text = text.slice(0, -1);
    return text;
  } catch {
    return url;
  }
}

function inferDocumentType(url) {
  return PDF_URL_RE.test(url) ? "PDF" : "HTML";
}

function isBoilerplate(text, url) {
  const haystack = `${text || ""} ${url || ""}`;
  return BOILERPLATE_RES.some((re) => re.test(haystack));
}

// Same match/matchUrl substring semantics as discovery/sourceDiscovery.js:
// `match` against link text, `matchUrl` against the resolved absolute URL.
function adapterRuleHits(linkText, resolvedUrl, adapterDocRules) {
  const hits = [];
  for (const rule of Array.isArray(adapterDocRules) ? adapterDocRules : []) {
    if (!rule || typeof rule.label !== "string") continue;
    const phrases = (Array.isArray(rule.match) ? rule.match : []).map((p) => String(p).toLowerCase());
    const urlPhrases = (Array.isArray(rule.matchUrl) ? rule.matchUrl : []).map((p) =>
      String(p).toLowerCase()
    );
    if (phrases.length === 0 && urlPhrases.length === 0) continue;
    const textHit =
      typeof linkText === "string" && phrases.some((phrase) => linkText.toLowerCase().includes(phrase));
    const urlHit = urlPhrases.some((phrase) => resolvedUrl.toLowerCase().includes(phrase));
    if (textHit || urlHit) hits.push(rule.label);
  }
  return hits;
}

function scoreLink(linkText, resolvedUrl, adapterDocRules) {
  const text = String(linkText || "");
  const urlLower = String(resolvedUrl || "").toLowerCase();
  const matchedSignals = [];
  const categoryScores = {};

  for (const category of DOCUMENT_CATEGORIES) {
    if (category === "OTHER") continue;
    let score = 0;
    const phrases = [...(CATEGORY_KEYWORDS[category] || [])].sort((a, b) => b.length - a.length);
    const textHit = phrases.find((phrase) => text.toLowerCase().includes(phrase));
    if (textHit) {
      score += TEXT_WEIGHT;
      matchedSignals.push({ signal: `text:${category}`, detail: `link text matches "${textHit}"`, weight: TEXT_WEIGHT });
    }
    const urlHit = phrases.find((phrase) => urlLower.includes(phrase));
    if (urlHit) {
      score += URL_WEIGHT;
      matchedSignals.push({ signal: `url:${category}`, detail: `URL matches "${urlHit}"`, weight: URL_WEIGHT });
    }
    if (score > 0) categoryScores[category] = score;
  }

  const revisionHit = REVISION_MARKERS.find(
    (marker) => text.toLowerCase().includes(marker) || urlLower.includes(marker)
  );
  if (revisionHit && Object.keys(categoryScores).length > 0) {
    matchedSignals.push({ signal: "revision-marker", detail: `revision marker "${revisionHit}"`, weight: REVISION_BONUS });
  }

  const ruleHits = adapterRuleHits(text, resolvedUrl, adapterDocRules);
  for (const label of ruleHits) {
    matchedSignals.push({ signal: `adapter-docrule:${label}`, detail: "matches a configured adapter document rule", weight: ADAPTER_RULE_WEIGHT });
  }

  let bestCategory = null;
  let bestScore = 0;
  for (const category of CATEGORY_PRIORITY) {
    const score = categoryScores[category] || 0;
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }
  let relevanceScore = bestScore + (revisionHit && bestScore > 0 ? REVISION_BONUS : 0) + ruleHits.length * ADAPTER_RULE_WEIGHT;
  if (bestCategory === null && ruleHits.length > 0) {
    bestCategory = "OTHER";
    relevanceScore = ruleHits.length * ADAPTER_RULE_WEIGHT;
  }
  return { bestCategory, relevanceScore, matchedSignals };
}

function evaluateLinks({ links, pageUrl, depth, sourceDomain, sameDomainOnly, adapterDocRules, discoveredAt, sink, stats }) {
  for (const link of links || []) {
    if (!link || typeof link.url !== "string") continue;
    stats.linksSeen += 1;
    const raw = link.url.trim();
    if (/^(mailto:|javascript:|#|tel:)/i.test(raw)) continue;
    let resolved;
    try {
      resolved = resolveUrl(raw, pageUrl);
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(resolved)) continue;
    const linkHost = hostOf(resolved);
    if (sameDomainOnly && linkHost !== sourceDomain) {
      stats.droppedCrossDomain += 1;
      continue;
    }
    const text = String(link.text || "").replace(/\s+/g, " ").trim();
    if (isBoilerplate(text, resolved)) {
      stats.droppedBoilerplate += 1;
      continue;
    }
    const { bestCategory, relevanceScore, matchedSignals } = scoreLink(text, resolved, adapterDocRules);
    if (bestCategory === null || relevanceScore < SCORE_THRESHOLD) continue;
    const key = normalizeUrl(resolved);
    if (sink.has(key)) {
      stats.duplicates += 1;
      continue;
    }
    sink.set(key, {
      url: resolved,
      sourceUrl: pageUrl,
      label: bestCategory,
      title: text || null,
      documentType: inferDocumentType(resolved),
      relevanceScore,
      matchedSignals,
      discoveredAt,
      depth: depth + 1,
    });
    stats.kept += 1;
  }
}

function finalize(sink, maxDocuments) {
  const documents = [...sink.values()].sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
  return documents.slice(0, maxDocuments);
}

function discoverDocumentsFromPages(source, pages, options = {}) {
  assertVerifiedSource(source);
  const sourceDomain = source.sourceDomain || hostOf(source.sourceUrl);
  const sameDomainOnly = options.sameDomainOnly !== false;
  const maxDocuments =
    typeof options.maxDocuments === "number" && options.maxDocuments >= 1
      ? Math.floor(options.maxDocuments)
      : 50;
  const discoveredAt = options.discoveredAt instanceof Date ? options.discoveredAt : new Date(options.discoveredAt || Date.now());
  const sink = new Map();
  const stats = { pagesVisited: 0, linksSeen: 0, kept: 0, droppedBoilerplate: 0, droppedCrossDomain: 0, duplicates: 0 };

  for (const page of Array.isArray(pages) ? pages : []) {
    if (!page || typeof page.html !== "string" || typeof page.url !== "string") continue;
    stats.pagesVisited += 1;
    const data = parseHTML(page.html);
    evaluateLinks({
      links: data.links,
      pageUrl: page.url,
      depth: typeof page.depth === "number" ? page.depth : 0,
      sourceDomain,
      sameDomainOnly,
      adapterDocRules: options.adapterDocRules,
      discoveredAt,
      sink,
      stats,
    });
  }

  return { documents: finalize(sink, maxDocuments), stats };
}

async function discoverFromSource(source, options = {}) {
  assertVerifiedSource(source);
  // Render-aware default: the adapter's own flag picks the transport, so js
  // sources are discovered through the browser instead of failing on HTTP.
  const fetchPage =
    typeof options.fetchPage === "function"
      ? options.fetchPage
      : async (url) => {
          const { fetchPageForAdapter } = require("../fetchers/transportSelector");
          const page = await fetchPageForAdapter(url, options.adapter);
          return { url: page.url, text: page.text };
        };
  const maxDepth = typeof options.maxDepth === "number" && options.maxDepth >= 0 ? Math.floor(options.maxDepth) : 1;
  const maxPages = typeof options.maxPages === "number" && options.maxPages >= 1 ? Math.floor(options.maxPages) : 5;
  const maxDocuments =
    typeof options.maxDocuments === "number" && options.maxDocuments >= 1
      ? Math.floor(options.maxDocuments)
      : 50;
  const sameDomainOnly = options.sameDomainOnly !== false;
  const discoveredAt = options.discoveredAt instanceof Date ? options.discoveredAt : new Date(options.discoveredAt || Date.now());
  const sourceDomain = source.sourceDomain || hostOf(source.sourceUrl);

  const sink = new Map();
  const stats = {
    pagesVisited: 0,
    linksSeen: 0,
    kept: 0,
    droppedBoilerplate: 0,
    droppedCrossDomain: 0,
    duplicates: 0,
    traversalEnqueued: 0,
  };
  const visited = new Set();
  const queue = [{ url: source.sourceUrl, depth: 0 }];

  while (queue.length > 0 && stats.pagesVisited < maxPages) {
    const current = queue.shift();
    const key = normalizeUrl(current.url);
    if (visited.has(key)) {
      stats.duplicates += 1;
      continue;
    }
    visited.add(key);
    let page;
    try {
      page = await fetchPage(current.url);
    } catch {
      continue;
    }
    if (!page || typeof page.text !== "string") continue;
    stats.pagesVisited += 1;
    const pageUrl = page.url || current.url;
    const data = parseHTML(page.text);
    const before = sink.size;
    evaluateLinks({
      links: data.links,
      pageUrl,
      depth: current.depth,
      sourceDomain,
      sameDomainOnly,
      adapterDocRules: options.adapterDocRules,
      discoveredAt,
      sink,
      stats,
    });
    // Bounded traversal: follow relevant, non-PDF, same-domain links while
    // depth and page budgets allow. PDFs are documents, not traversal nodes.
    if (current.depth < maxDepth) {
      for (const doc of [...sink.values()].slice(before)) {
        if (doc.documentType === "PDF") continue;
        if (doc.sourceUrl !== pageUrl) continue;
        if (sameDomainOnly && hostOf(doc.url) !== sourceDomain) continue;
        const docKey = normalizeUrl(doc.url);
        if (!visited.has(docKey)) {
          queue.push({ url: doc.url, depth: current.depth + 1 });
          stats.traversalEnqueued += 1;
        }
      }
    }
  }

  return { documents: finalize(sink, maxDocuments), stats };
}

module.exports = {
  DOCUMENT_CATEGORIES,
  CATEGORY_PRIORITY,
  CATEGORY_KEYWORDS,
  REVISION_MARKERS,
  SCORE_THRESHOLD,
  discoverDocumentsFromPages,
  discoverFromSource,
  // STEP 21 reuse (additive only — behavior unchanged): link helpers for the
  // observed-only bulletin fallback.
  adapterRuleHits,
  hostOf,
  normalizeUrl,
  inferDocumentType,
  isBoilerplate,
};
