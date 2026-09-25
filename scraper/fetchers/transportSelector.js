// =============================================================================
// scraper/fetchers/transportSelector.js — STEP 20 render-aware selection
// =============================================================================
// WHAT: The single place that maps an adapter's `render` flag to a fetch
//   implementation. Static adapters (or no adapter) keep the existing plain
//   HTTP path byte-for-byte; adapters declaring render "js" use the existing
//   Step 1 pooled-browser transport (Crawlee), including its browser download
//   capture for PDFs discovered through JS pages.
// WHY: Discovery and ingestion defaulted to HTTP_unconditionally — even for
//   adapters that declare JS rendering — so js sources could never be fetched
//   through their configured transport, and js PDFs hit the known Chromium
//   download failure. Selection follows configuration only, never identity.
// CONTRACTS (normalized shapes match the existing fetchers, so downstream
//   parsing/discovery/extraction are untouched):
//   isBrowserAdapter(adapter) -> render === "js".
//   fetchPageForAdapter(url, adapter, opts?)
//     static/unknown -> fetchHTML result verbatim { url, text, status }.
//     js            -> { url, text, status, transport: "browser", stats? }.
//   fetchDocumentForAdapter(discovered, adapter, opts?)
//     static/unknown -> documentFetcher.fetchDocument result verbatim.
//     js + PDF      -> RawDocument with Buffer content via the Step 1 browser
//                      download capture (transport: "browser").
//     js + HTML     -> RawDocument with text content via pooled browser.
//   crawlOptsOf() mapping (timeout/retries, incl. adapter.crawl overrides)
//   comes from crawleeTransport; explicit opts win. One known delta vs the
//   legacy per-request browser fetcher: the pooled transport applies its
//   configured retries (default 2, adapter-overridable) where the legacy path
//   did none — retries only, semantics otherwise identical.
// GENERICITY: render flag only. No exam names, no per-source branches.
// =============================================================================

function isBrowserAdapter(adapter) {
  return !!adapter && adapter.render === "js";
}

async function fetchPageForAdapter(url, adapter, opts = {}) {
  if (!isBrowserAdapter(adapter)) {
    const { fetchHTML } = require("./httpFetcher");
    return fetchHTML(url, opts);
  }
  const { fetchPageViaCrawlee, crawlOptsOf } = require("./crawleeTransport");
  const { timeout, retries } = crawlOptsOf(adapter, true);
  const res = await fetchPageViaCrawlee(url, { timeout, retries, ...opts, useBrowser: true });
  return { url: res.url, text: res.text, status: res.status, transport: "browser", stats: res.stats };
}

async function fetchDocumentForAdapter(discovered, adapter, opts = {}) {
  if (!discovered || typeof discovered.url !== "string") {
    throw new Error("transportSelector: discovered document has no url");
  }
  if (!isBrowserAdapter(adapter)) {
    return require("./documentFetcher").fetchDocument(discovered, adapter);
  }
  const { fetchPdfViaBrowserCrawlee, crawlOptsOf } = require("./crawleeTransport");
  const { timeout, retries } = crawlOptsOf(adapter, true);
  const merged = { timeout, retries, ...opts };
  const fetchedAt = new Date();
  if (discovered.type === "PDF") {
    const res = await fetchPdfViaBrowserCrawlee(discovered.url, merged);
    return {
      label: discovered.label || null,
      url: res.url,
      sourceUrl: discovered.sourceUrl || null,
      type: "PDF",
      fetchedAt,
      status: res.status,
      contentType: res.contentType || null,
      content: res.buffer,
      transport: "browser",
    };
  }
  const page = await fetchPageForAdapter(discovered.url, adapter, opts);
  return {
    label: discovered.label || null,
    url: page.url,
    sourceUrl: discovered.sourceUrl || null,
    type: discovered.type || "HTML",
    fetchedAt,
    status: page.status,
    contentType: null,
    content: page.text,
    transport: "browser",
  };
}

module.exports = {
  isBrowserAdapter,
  fetchPageForAdapter,
  fetchDocumentForAdapter,
};
