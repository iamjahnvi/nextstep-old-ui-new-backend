// =============================================================================
// scraper/fetchers/documentFetcher.js
// =============================================================================
// WHAT: Generic document retrieval. Turns a discovered document
//   ({ label, url, sourceUrl, type } from discovery/sourceDiscovery) into a
//   normalized in-memory RawDocument. No exam knowledge, no parsing here —
//   DISCOVER → RETRIEVE only; HTML goes to the HTML parser, PDF to the PDF
//   parser in a later stage.
// WHY: Retrieval must reuse the adapter's fetch strategy (render flag), so a
//   source works the same whether it needs plain HTTP or a browser. PDFs keep
//   raw bytes (Buffer); HTML keeps text. Nothing is transcoded early and
//   nothing is persisted (DB staging comes in a later phase).
// CONTRACT:
//   fetchDocument(discovered, adapter)
//     discovered : { label, url, sourceUrl, type } (absolute url).
//     adapter    : validated adapter config (`.render` selects the strategy;
//                  `.crawl` supplies timeout/retries, if configured).
//   crawlFetchOptions(adapter) -> fetch options ({ timeout?, retries? }).
//     Only explicitly configured crawl values are forwarded; anything unset
//     is left out so each fetcher keeps its own default (behavior-preserving).
//   crawlDelayMs(adapter) -> non-negative delay between requests (0 default).
//   Returns RawDocument:
//     { label, url, sourceUrl, type, fetchedAt, status, contentType, content }
//     content is a Buffer for PDF, a string otherwise.
// =============================================================================
// Crawler = the part that travels around the website and fetches the stuff.
const { fetchHTML, fetchBinary } = require("./httpFetcher");
const { fetchViaBrowser, fetchBinaryViaBrowser } = require("./browserFetcher");

// These are the two ways the scraper can fetch content:
// HTTP fetcher   → normal HTTP request
// Browser fetcher → Playwright/browser request

function crawlFetchOptions(adapter) {
// It receives an exam adapter/config. For example:
// adapter.crawl = {
//   timeoutMs: 30000,
//   maxRetries: 3
// }
  const crawl = (adapter && adapter.crawl) || {};
  // Get adapter.crawl; if it doesn't exist, use {} instead.
  const opts = {};
  if (crawl.timeoutMs !== undefined && crawl.timeoutMs !== null) {
    opts.timeout = crawl.timeoutMs;
  }
  if (crawl.maxRetries !== undefined && crawl.maxRetries !== null) {
    opts.retries = crawl.maxRetries;
  }
  return opts;
}

function crawlDelayMs(adapter) {
  const crawl = (adapter && adapter.crawl) || {};
  const delay = crawl.requestDelayMs;
  return typeof delay === "number" && delay > 0 ? delay : 0;
}

async function fetchDocument(discovered, adapter) {
  // This function is the document downloader. It takes a document that was already discovered and actually fetches it. 
  if (!discovered || typeof discovered.url !== "string") {
    // Makes sure we actually have a valid URL.
    // If not → throws an error.
    throw new Error("documentFetcher: discovered document has no url");
  }
  const useBrowser =
    adapter && adapter.render === "js" ? true : false;
    // as the function name sugggests that if render is js then true, use browser otherwise no, don't use browser.

  const fetchedAt = new Date();
  // Stores when the document was fetched.

  const fetchOpts = crawlFetchOptions(adapter);
  // Gets things like: timeout and max retries, from the adapter.

  if (discovered.type === "PDF") {
    const res = useBrowser
      ? await fetchBinaryViaBrowser(discovered.url, fetchOpts)
      : await fetchBinary(discovered.url, fetchOpts);
    return {
      label: discovered.label || null,
      url: res.url,
      sourceUrl: discovered.sourceUrl || null,
      type: "PDF",
      fetchedAt,
      status: res.status,
      contentType: res.contentType || null,
      content: res.buffer,
    };
  }

  const res = useBrowser
    ? await fetchViaBrowser(discovered.url, fetchOpts)
    : await fetchHTML(discovered.url, fetchOpts);
  return {
    label: discovered.label || null,
    url: res.url,
    sourceUrl: discovered.sourceUrl || null,
    type: discovered.type || "HTML",
    fetchedAt,
    status: res.status,
    contentType: null,
    content: res.text,
  };
}

module.exports = {
  fetchDocument,
  crawlFetchOptions,
  crawlDelayMs,
};

// Discovered document
//        ↓
//    fetchDocument()
//        ↓
//  Is it PDF?
//    /      \
//  YES       NO
//   ↓         ↓
// PDF fetch  HTML fetch
//   \         /
//    \       /
//     ↓     ↓
// Standard document object
//         ↓
//      PARSER