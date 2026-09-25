// =============================================================================
// scraper/discovery/sourceProfiler.js — STEP 3 source profiling
// =============================================================================
// WHAT: Technical profiling of a candidate source WITHOUT crawling it. From
//   the source URL, an optional lightweight content sample (content type and/or
//   HTML the caller already holds), and trusted adapter render configuration,
//   it answers what future ingestion likely needs: profile type, transport
//   recommendation, document types, and whether JavaScript is required.
// WHY: Fetching the wrong way wastes runs — a JS-shelled site 403s plain HTTP
//   (seen live with JEE Main), while a static page never needs a browser. The
//   profile lets later stages pick HTTP vs BROWSER before spending a crawl.
// CATEGORIES: STATIC_HTML | JAVASCRIPT_HTML | PDF | MIXED | UNKNOWN.
//   - PDF: the source URL itself addresses a PDF document.
//   - JAVASCRIPT_HTML: a trusted adapter renders this host with a browser, or
//     strong SPA markers are evidenced in the sample.
//   - MIXED: an HTML page that also links PDF documents (static fetch for the
//     page, binary fetch for the documents).
//   - STATIC_HTML: HTML with no JS requirement and no document links.
//   - UNKNOWN: no signal at all — later stages must probe, not assume.
// CONSERVATISM: generic <script> tags (analytics, widgets) never imply
//   JavaScript rendering; only strong SPA markers (framework roots, embedded
//   app state) or explicit adapter configuration do. Absence of evidence is
//   UNKNOWN, never STATIC.
// CONTRACTS (all pure, no I/O, no network):
//   profileFromSignals({ url, contentType, html, adapterRender })
//     -> { type, transport, documentTypes, requiresJavaScript, signals[] }.
//        requiresJavaScript is true | false | null (null = unknown).
//   profileCandidate(candidateLike, { adapters, sample })
//     -> same shape (resolves adapterRender by matching the candidate host
//        against trusted adapter officialWebsite hosts; sample is optional).
// TRANSPORT LOGIC: PDF -> HTTP (direct binary); JAVASCRIPT_HTML -> BROWSER;
//   STATIC_HTML/MIXED -> HTTP (MIXED documents ride the binary fetcher later);
//   UNKNOWN -> UNKNOWN.
// GENERICITY: no exam names, board names, or hosts anywhere in this file.
// =============================================================================

const PROFILE_TYPES = ["STATIC_HTML", "JAVASCRIPT_HTML", "PDF", "MIXED", "UNKNOWN"];
const TRANSPORT_TYPES = ["HTTP", "BROWSER", "UNKNOWN"];
const DOCUMENT_TYPES = ["HTML", "PDF", "MIXED", "UNKNOWN"];
const PROFILER_TAG = "sourceProfiler.v1";

const PDF_URL_RE = /\.pdf([?#]|$)/i;
const PDF_LINK_RE = /href\s*=\s*["'][^"']*\.pdf([?#][^"']*)?["']/i;
const SCRIPT_RE = /<script[\s>]/i;
// Strong SPA markers: framework mount points / embedded app state — not the
// generic script tags every modern page carries for analytics.
const SPA_MARKER_RES = [/__NEXT_DATA__/, /ng-app\b/i, /id\s*=\s*["']root["']/, /data-reactroot/i];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function adapterRenderFor(host, adapters) {
  if (!host) return null;
  for (const adapter of Array.isArray(adapters) ? adapters : []) {
    if (!adapter || typeof adapter.officialWebsite !== "string") continue;
    if (hostOf(adapter.officialWebsite) === host) return adapter.render || null;
  }
  return null;
}

function profileFromSignals(input = {}) {
  const url = typeof input.url === "string" ? input.url : "";
  const contentType = typeof input.contentType === "string" ? input.contentType.toLowerCase() : null;
  const html = typeof input.html === "string" ? input.html : null;
  const adapterRender = input.adapterRender === "js" || input.adapterRender === "static" ? input.adapterRender : null;
  const signals = [];

  const pdfUrl = PDF_URL_RE.test(url);
  if (pdfUrl) signals.push({ signal: "pdf-url", detail: `source URL addresses a PDF document` });
  const pdfContent = contentType !== null && contentType.includes("pdf");
  if (pdfContent) signals.push({ signal: "pdf-content-type", detail: `content type "${contentType}"` });
  const htmlContent = contentType !== null && contentType.includes("html");
  if (htmlContent) signals.push({ signal: "html-content-type", detail: `content type "${contentType}"` });
  const pdfLinks = html !== null && PDF_LINK_RE.test(html);
  if (pdfLinks) signals.push({ signal: "pdf-links", detail: "HTML sample links at least one PDF document" });
  const spaMarkers = html !== null ? SPA_MARKER_RES.filter((re) => re.test(html)) : [];
  if (spaMarkers.length > 0) {
    signals.push({ signal: "spa-markers", detail: `${spaMarkers.length} strong single-page-app marker(s) in HTML sample` });
  } else if (html !== null && SCRIPT_RE.test(html)) {
    signals.push({ signal: "generic-scripts", detail: "generic script tags only — not evidence of JS rendering" });
  }
  if (adapterRender !== null) {
    signals.push({
      signal: "adapter-render",
      detail: `trusted adapter configuration renders this host as "${adapterRender}"`,
    });
  }

  const finish = (type, transport, documentTypes, requiresJavaScript) => ({
    type,
    transport,
    documentTypes,
    requiresJavaScript,
    signals,
    profiler: PROFILER_TAG,
  });

  // A direct PDF address wins: the bytes are the source, whatever else holds.
  if (pdfUrl || pdfContent) {
    return finish("PDF", "HTTP", "PDF", false);
  }
  // Explicit browser-render configuration wins over page-shape guessing.
  if (adapterRender === "js") {
    return finish("JAVASCRIPT_HTML", "BROWSER", pdfLinks ? "MIXED" : "HTML", true);
  }
  // Strong SPA markers evidence JS rendering even without adapter knowledge.
  if (spaMarkers.length > 0) {
    return finish("JAVASCRIPT_HTML", "BROWSER", pdfLinks ? "MIXED" : "HTML", true);
  }
  // HTML evidence decides between document-heavy and plain static pages.
  if (htmlContent || html !== null || adapterRender === "static") {
    if (pdfLinks) return finish("MIXED", "HTTP", "MIXED", false);
    return finish("STATIC_HTML", "HTTP", "HTML", false);
  }
  return finish("UNKNOWN", "UNKNOWN", "UNKNOWN", null);
}

function profileCandidate(candidateLike, options = {}) {
  const candidate = candidateLike || {};
  const url = candidate.examUrl || candidate.sourceUrl || "";
  const sample = options.sample || {};
  const render = adapterRenderFor(hostOf(url), options.adapters);
  return profileFromSignals({
    url,
    contentType: sample.contentType,
    html: sample.html,
    adapterRender: render,
  });
}

module.exports = {
  PROFILE_TYPES,
  TRANSPORT_TYPES,
  DOCUMENT_TYPES,
  PROFILER_TAG,
  profileFromSignals,
  profileCandidate,
};
