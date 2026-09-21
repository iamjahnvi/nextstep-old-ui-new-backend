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

const { fetchHTML, fetchBinary } = require("./httpFetcher");
const { fetchViaBrowser, fetchBinaryViaBrowser } = require("./browserFetcher");

function crawlFetchOptions(adapter) {
  const crawl = (adapter && adapter.crawl) || {};
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
  if (!discovered || typeof discovered.url !== "string") {
    throw new Error("documentFetcher: discovered document has no url");
  }
  const useBrowser =
    adapter && adapter.render === "js" ? true : false;
  const fetchedAt = new Date();
  const fetchOpts = crawlFetchOptions(adapter);

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
