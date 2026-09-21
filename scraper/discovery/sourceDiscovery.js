// =============================================================================
// scraper/discovery/sourceDiscovery.js
// =============================================================================
// WHAT: Generic source discovery. Turns (parsed links + adapter docRules) into
//   structured discovered documents. No exam knowledge, no hardcoded phrases —
//   every match phrase lives in the registry adapter config.
// WHY: Discovery is a reusable engine concern: match → resolve → type. Exam /
//   source differences are data (docRules), never branches here.
// CONTRACT:
//   discoverDocuments(links, docRules, sourceUrl)
//     links     : [{ text, url }] as returned by parsers/htmlParser.
//     docRules  : [{ label, match?, matchUrl?, type?: "HTML"|"PDF"|"OTHER" }].
//                 Phrases are case-insensitive substrings: `match` against
//                 link text, `matchUrl` against the resolved absolute URL.
//                 A rule matches when either side hits.
//     sourceUrl : absolute URL of the page the links came from. Relative hrefs
//                 are resolved against it. If omitted, hrefs pass through raw
//                 and URL matching runs against the raw href.
//   Returns: array of { label, text, url, sourceUrl, type } — one entry per
//     MATCHED rule (first hit wins), in docRules order. Unmatched labels are
//     omitted (never null-padded). Does NOT fetch or parse anything.
// =============================================================================

const { resolveUrl } = require("../fetchers/httpFetcher");

function inferTypeFromUrl(url) {
  if (typeof url !== "string") return null;
  return /\.pdf([?#]|$)/i.test(url) ? "PDF" : null;
}

function discoverDocuments(links, docRules, sourceUrl) {
  const list = Array.isArray(links) ? links : [];
  const rules = Array.isArray(docRules) ? docRules : [];
  const found = [];

  for (const rule of rules) {
    if (!rule || typeof rule.label !== "string") continue;
    const phrases = (Array.isArray(rule.match) ? rule.match : []).map((p) =>
      String(p).toLowerCase()
    );
    const urlPhrases = (Array.isArray(rule.matchUrl) ? rule.matchUrl : []).map(
      (p) => String(p).toLowerCase()
    );
    if (phrases.length === 0 && urlPhrases.length === 0) continue;

    const hit = list.find((link) => {
      if (!link || typeof link.url !== "string") return false;
      // URL matching runs against the resolved absolute URL so relative
      // hrefs like "documents/x.pdf" are addressable by config. An
      // unresolvable href falls back to raw (fetch will fail loudly later).
      let resolved;
      try {
        resolved = sourceUrl ? resolveUrl(link.url, sourceUrl) : link.url;
      } catch {
        resolved = link.url;
      }
      const textHit =
        typeof link.text === "string" &&
        phrases.some((phrase) => link.text.toLowerCase().includes(phrase));
      const urlHit = urlPhrases.some((phrase) =>
        resolved.toLowerCase().includes(phrase)
      );
      return textHit || urlHit;
    });
    if (!hit) continue;

    const url = sourceUrl ? resolveUrl(hit.url, sourceUrl) : hit.url;
    found.push({
      label: rule.label,
      text: hit.text,
      url,
      sourceUrl: sourceUrl || null,
      type: rule.type || inferTypeFromUrl(hit.url) || "HTML",
    });
  }

  return found;
}

module.exports = {
  discoverDocuments,
  inferTypeFromUrl,
};
