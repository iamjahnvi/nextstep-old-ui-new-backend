// =============================================================================
// scraper/pipeline/crawlSource.js
// =============================================================================
// WHAT: Shared fetch → parse → discover → retrieve sequence for one adapter.
//   Returns the landing page plus retrieved RawDocument-like objects WITHOUT
//   persisting anything — callers decide what persistence means:
//     ingestionPipeline.js persists each raw via saveRawDocument.
//     driftReport.js      checks each raw via checkDrift.
// WHY: One crawler, two monitoring/persistence policies. The sequencing
//   (strategy from adapter.render, politeness from adapter.crawl, delay
//   between consecutive requests but never before the first) lives here once
//   instead of being duplicated per pipeline.
// SCOPE: network + parsing only. No database, no checksums, no extraction,
//   no review, no publishing. Adapter must already be schema-validated.
// CONTRACT:
//   crawlSource(adapter)
//     adapter : validated registry adapter object.
//   Returns { landing, raws }:
//     landing : { url, text, status } of the start URL fetch.
//     raws    : retrieved documents [{ label, url, sourceUrl, type,
//               fetchedAt, status, contentType, content }], Buffer for PDF.
// =============================================================================

const { fetchHTML, sleep } = require("../fetchers/httpFetcher");
const { fetchViaBrowser } = require("../fetchers/browserFetcher");
const parseHTML = require("../parsers/htmlParser");
const { discoverDocuments } = require("../discovery/sourceDiscovery");
const {
  fetchDocument,
  crawlFetchOptions,
  crawlDelayMs,
} = require("../fetchers/documentFetcher");

async function crawlSource(adapter) {
  if (!adapter || !Array.isArray(adapter.startUrls) || !adapter.startUrls[0]) {
    throw new Error("crawlSource: adapter with startUrls is required");
  }

  // Fetch strategy is generic: adapter.render only, never exam identity.
  // Crawl settings travel with every request; the delay spaces consecutive
  // requests (never the first one).
  const fetchOpts = crawlFetchOptions(adapter);
  const delayMs = crawlDelayMs(adapter);
  const fetchPage = adapter.render === "js" ? fetchViaBrowser : fetchHTML;
  const landing = await fetchPage(adapter.startUrls[0], fetchOpts);

  const data = parseHTML(landing.text);
  const discovered = discoverDocuments(
    data.links,
    adapter.docRules,
    landing.url
  );

  const raws = [];
  for (const meta of discovered) {
    if (delayMs > 0) await sleep(delayMs);
    raws.push(await fetchDocument(meta, adapter));
  }

  return { landing, raws };
}

module.exports = {
  crawlSource,
};
