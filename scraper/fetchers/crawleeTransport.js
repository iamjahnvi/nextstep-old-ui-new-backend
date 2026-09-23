// =============================================================================
// scraper/fetchers/crawleeTransport.js — STEP 1 shadow evaluation
// =============================================================================
// WHAT: Crawlee-backed crawling/transport beside the existing fetchers. Covers
//   ONLY transport: queueing, dedup, retries, concurrency, timeouts, browser
//   pooling, per-request stats, clean shutdown. No extraction, normalization,
//   validation, provenance, review, or publishing logic lives here — discovery
//   still uses discovery/sourceDiscovery.js and parsing still uses
//   parsers/htmlParser.js via the shared crawlViaCrawlee flow.
// WHY: Evaluate Crawlee as the future Node transport without touching the
//   default path. Modes (CRAWLEE_TRANSPORT, default "off"):
//     off    : existing implementation only (default; zero behavior change).
//     shadow : existing implementation is primary; Crawlee runs as comparison.
//              A Crawlee failure never fails the primary result.
//     on     : Crawlee only (experimental; NOT the default).
// CONTRACTS mirror the existing fetchers so results stay comparable:
//   fetchPageViaCrawlee(url, opts)   -> { url, text, status } (HTML)
//   fetchBinaryViaCrawlee(url, opts) -> { url, status, buffer, contentType }
//   fetchPdfViaBrowserCrawlee(url, opts) -> { url, status, buffer,
//     contentType, via } — Chromium treats PDF navigation as a download
//     ("Download is starting"); the transport captures the download bytes via
//     the download event instead of failing like fetchBinaryViaBrowser does.
//   crawlViaCrawlee(adapter) -> { landing, raws, stats } — same { landing,
//     raws } shape as pipeline/crawlSource.js plus a stats block.
// SCOPE NOTES:
//   - Adapter-driven and generic: reads adapter.render/.crawl/.startUrls/
//     docRules; no exam names, no exam branches (see tests).
//   - Politeness is enforced deterministically (sleep between consecutive
//     requests, never before the first) because Crawlee's sameDomainDelaySecs
//     did not reproduce the configured delay reliably in evaluation.
//   - Crawlee storage is isolated per process to os.tmpdir() (never the repo,
//     never MongoDB); default purge-on-start keeps runs independent.
// =============================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");

const parseHTML = require("../parsers/htmlParser");
const { discoverDocuments } = require("../discovery/sourceDiscovery");

// Quiet-by-default transport: only loud when the operator asks.
if (!process.env.CRAWLEE_LOG_LEVEL) process.env.CRAWLEE_LOG_LEVEL = "ERROR";

const {
  BasicCrawler,
  CheerioCrawler,
  PlaywrightCrawler,
  RequestQueue,
} = require("crawlee");

const TRANSPORT_MODES = ["off", "shadow", "on"];
const DEFAULT_MAX_RETRIES = 2; // parity with fetchers/httpFetcher.js
const DEFAULT_TIMEOUT_MS = 15000; // parity with fetchers/httpFetcher.js
const BROWSER_TIMEOUT_MS = 30000; // parity with fetchers/browserFetcher.js

function getTransportMode(env = process.env) {
  const raw = env && env.CRAWLEE_TRANSPORT;
  const mode = typeof raw === "string" ? raw.toLowerCase().trim() : "off";
  return TRANSPORT_MODES.includes(mode) ? mode : "off";
}

// One Crawlee storage dir per process (os temp, never the repo, never
// MongoDB). Every run additionally gets a uniquely-named RequestQueue: the
// default queue keeps handled-state across runs in one process (a same-URL
// revisit would be silently skipped), so run isolation must not rely on it.
// Named queues accumulate as small files under the process temp dir (OS-temp
// lifecycle); run-to-run independence is asserted by tests, not by purging.
let processStorageDir = null;
function ensureProcessStorageDir() {
  if (!processStorageDir) {
    processStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "nextstep-crawlee-"));
  }
  if (process.env.CRAWLEE_STORAGE_DIR !== processStorageDir) {
    process.env.CRAWLEE_STORAGE_DIR = processStorageDir;
  }
  return processStorageDir;
}

let runCounter = 0;
async function freshQueue() {
  ensureProcessStorageDir();
  runCounter += 1;
  return RequestQueue.open(`nextstep-run-${process.pid}-${Date.now()}-${runCounter}`);
}

// Sequential enqueue so the queue observes each URL against the requests
// already present: duplicates report wasAlreadyPresent instead of slipping
// through inside one batch. Returns { added, dedupSkipped }.
async function enqueueSequential(crawler, requests) {
  let added = 0;
  let dedupSkipped = 0;
  for (const req of requests) {
    const res = await crawler.addRequests([req]);
    for (const r of (res && res.addedRequests) || []) {
      if (r.wasAlreadyPresent) dedupSkipped += 1;
      else added += 1;
    }
  }
  return { added, dedupSkipped };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Deterministic politeness: sleep delayMs since the previous mark, skipping
// the first request. Mirrors crawlSource's "delay between consecutive
// requests but never before the first".
function createPoliteness(delayMs) {
  const delay = typeof delayMs === "number" && delayMs > 0 ? delayMs : 0;
  let lastStart = 0;
  return {
    delayMs: delay,
    async wait() {
      if (delay <= 0) return 0;
      const now = Date.now();
      if (lastStart === 0) {
        lastStart = now;
        return 0;
      }
      const waitMs = delay - (now - lastStart);
      if (waitMs > 0) await sleep(waitMs);
      lastStart = Date.now();
      return Math.max(waitMs, 0);
    },
  };
}

function crawlOptsOf(adapter, isBrowser) {
  const crawl = (adapter && adapter.crawl) || {};
  const timeout =
    typeof crawl.timeoutMs === "number" && crawl.timeoutMs > 0
      ? crawl.timeoutMs
      : isBrowser
        ? BROWSER_TIMEOUT_MS
        : DEFAULT_TIMEOUT_MS;
  const retries =
    typeof crawl.maxRetries === "number" && crawl.maxRetries >= 0
      ? crawl.maxRetries
      : DEFAULT_MAX_RETRIES;
  const delay =
    typeof crawl.requestDelayMs === "number" && crawl.requestDelayMs > 0
      ? crawl.requestDelayMs
      : 0;
  return { timeout, retries, delay };
}

function statsOf(perRequest, extra = {}) {
  const finished = perRequest.filter((r) => r.ok).length;
  return {
    requests: perRequest.length,
    finished,
    failed: perRequest.length - finished,
    totalRetries: perRequest.reduce((n, r) => n + (r.attempts > 0 ? r.attempts - 1 : 0), 0),
    perRequest,
    ...extra,
  };
}

// ---------------------------------------------------------------- HTML page

async function fetchPageViaCrawlee(url, options = {}) {
  ensureProcessStorageDir();
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_MAX_RETRIES,
    useBrowser = false,
  } = options;
  const timeoutSecs = Math.max(timeout / 1000, 0.1);
  const perRequest = [];
  const t0 = Date.now();

  if (!useBrowser) {
    let outcome = null;
    let failure = null;
    const crawler = new CheerioCrawler({
      requestQueue: await freshQueue(),
      maxRequestsPerCrawl: 2,
      maxConcurrency: 1,
      maxRequestRetries: retries,
      navigationTimeoutSecs: timeoutSecs,
      requestHandlerTimeoutSecs: Math.max(timeoutSecs, 60),
      async requestHandler({ request, body, response }) {
        outcome = {
          url: request.url,
          text: typeof body === "string" ? body : String(body),
          status: response ? response.statusCode : null,
          attempts: (request.retryCount || 0) + 1,
        };
      },
      async failedRequestHandler({ request, error }) {
        failure = {
          attempts: (request.retryCount || 0) + 1,
          message: (error && error.message) || String(error),
          code: (error && error.code) || null,
        };
      },
    });
    await enqueueSequential(crawler, [{ url, uniqueKey: url }]);
    await crawler.run();
    if (outcome) {
      perRequest.push({ url, ok: true, ...outcome, durationMs: Date.now() - t0 });
      return { url: outcome.url, text: outcome.text, status: outcome.status, stats: statsOf(perRequest) };
    }
    perRequest.push({ url, ok: false, attempts: failure ? failure.attempts : 1, durationMs: Date.now() - t0 });
    throw new Error(`crawleeTransport: GET ${url} failed (${failure ? failure.message : "unknown"})`);
  }

  let outcome = null;
  let failure = null;
  const crawler = new PlaywrightCrawler({
    requestQueue: await freshQueue(),
    maxRequestsPerCrawl: 2,
    maxConcurrency: 1,
    maxRequestRetries: retries,
    navigationTimeoutSecs: timeoutSecs,
    requestHandlerTimeoutSecs: Math.max(timeoutSecs, 60),
    async requestHandler({ request, page, response }) {
      const text = await page.content();
      outcome = {
        url: page.url() || request.url,
        text,
        status: response ? response.status() : null,
        attempts: (request.retryCount || 0) + 1,
      };
    },
    async failedRequestHandler({ request, error }) {
      failure = {
        attempts: (request.retryCount || 0) + 1,
        message: (error && error.message) || String(error),
        code: (error && error.code) || null,
      };
    },
  });
  await enqueueSequential(crawler, [{ url, uniqueKey: url }]);
  await crawler.run();
  if (outcome) {
    perRequest.push({ url, ok: true, ...outcome, durationMs: Date.now() - t0 });
    return { url: outcome.url, text: outcome.text, status: outcome.status, stats: statsOf(perRequest) };
  }
  perRequest.push({ url, ok: false, attempts: failure ? failure.attempts : 1, durationMs: Date.now() - t0 });
  throw new Error(`crawleeTransport: GET ${url} failed (${failure ? failure.message : "unknown"})`);
}

// ---------------------------------------------------------------- binary

async function fetchBinaryViaCrawlee(url, options = {}) {
  ensureProcessStorageDir();
  const { timeout = DEFAULT_TIMEOUT_MS, retries = DEFAULT_MAX_RETRIES } = options;
  const timeoutSecs = Math.max(timeout / 1000, 0.1);
  const perRequest = [];
  const t0 = Date.now();
  let outcome = null;
  let failure = null;
  const crawler = new BasicCrawler({
    requestQueue: await freshQueue(),
    maxRequestsPerCrawl: 2,
    maxConcurrency: 1,
    maxRequestRetries: retries,
    requestHandlerTimeoutSecs: Math.max(timeoutSecs, 60),
    async requestHandler({ request, sendRequest }) {
      const res = await sendRequest({
        url: request.url,
        responseType: "buffer",
        timeout: { request: timeout },
      });
      outcome = {
        url: request.url,
        status: res.statusCode,
        buffer: Buffer.from(res.body),
        contentType: (res.headers && res.headers["content-type"]) || null,
        attempts: (request.retryCount || 0) + 1,
      };
    },
    async failedRequestHandler({ request, error }) {
      failure = {
        attempts: (request.retryCount || 0) + 1,
        message: (error && error.message) || String(error),
        code: (error && error.code) || null,
      };
    },
  });
  await enqueueSequential(crawler, [{ url, uniqueKey: url }]);
  await crawler.run();
  if (outcome) {
    perRequest.push({ url, ok: true, attempts: outcome.attempts, durationMs: Date.now() - t0 });
    return { ...outcome, stats: statsOf(perRequest) };
  }
  perRequest.push({ url, ok: false, attempts: failure ? failure.attempts : 1, durationMs: Date.now() - t0 });
  throw new Error(`crawleeTransport: GET ${url} failed (${failure ? failure.message : "unknown"})`);
}

// ------------------------------------------------- browser PDF via download
//
// Chromium turns PDF navigation into a download ("Download is starting") —
// the same failure the current fetchBinaryViaBrowser has (Step 0 baseline).
// The transport captures the download bytes via the download event instead of
// failing. Download intent comes from discovery (discovered.type === "PDF"),
// never from exam identity.

async function fetchPdfViaBrowserCrawlee(url, options = {}) {
  ensureProcessStorageDir();
  const { timeout = BROWSER_TIMEOUT_MS, retries = DEFAULT_MAX_RETRIES } = options;
  const timeoutSecs = Math.max(timeout / 1000, 0.1);
  const perRequest = [];
  const t0 = Date.now();
  const waiters = new Map();
  let outcome = null;
  let failure = null;

  const crawler = new PlaywrightCrawler({
    requestQueue: await freshQueue(),
    maxRequestsPerCrawl: retries + 2,
    maxConcurrency: 1,
    maxRequestRetries: retries,
    navigationTimeoutSecs: timeoutSecs,
    requestHandlerTimeoutSecs: Math.max(timeoutSecs, 60),
    preNavigationHooks: [
      async ({ page, request }) => {
        waiters.set(
          request.id,
          page.waitForEvent("download", { timeout: Math.max(timeout - 1000, 1000) }).catch(() => null)
        );
      },
    ],
    async requestHandler({ request, response }) {
      // A PDF that renders instead of downloading: keep the response bytes.
      const body = response ? await response.body().catch(() => null) : null;
      if (body) {
        const headers = response ? await response.allHeaders().catch(() => ({})) : {};
        outcome = {
          url: request.url,
          status: response ? response.status() : null,
          buffer: Buffer.from(body),
          contentType: headers["content-type"] || null,
          via: "browser-response",
          attempts: (request.retryCount || 0) + 1,
        };
      }
    },
    async failedRequestHandler({ request, error }) {
      const message = (error && error.message) || String(error);
      if (/download is starting/i.test(message)) {
        const download = await (waiters.get(request.id) || null);
        if (download) {
          const filePath = await download.path().catch(() => null);
          if (filePath) {
            const buffer = fs.readFileSync(filePath);
            outcome = {
              url: request.url,
              status: null,
              buffer,
              contentType: "application/pdf",
              via: "browser-download",
              attempts: (request.retryCount || 0) + 1,
            };
            return;
          }
        }
      }
      failure = {
        attempts: (request.retryCount || 0) + 1,
        message,
        code: (error && error.code) || null,
      };
    },
  });
  await enqueueSequential(crawler, [{ url, uniqueKey: url, userData: { isPdf: true } }]);
  await crawler.run();
  if (outcome) {
    perRequest.push({ url, ok: true, attempts: outcome.attempts, via: outcome.via, durationMs: Date.now() - t0 });
    return { ...outcome, stats: statsOf(perRequest) };
  }
  perRequest.push({ url, ok: false, attempts: failure ? failure.attempts : 1, durationMs: Date.now() - t0 });
  throw new Error(`crawleeTransport: GET ${url} failed (${failure ? failure.message : "unknown"})`);
}

// ------------------------------------------------- adapter crawl (queue)
//
// Mirrors pipeline/crawlSource.js sequencing (landing -> parse -> discover ->
// retrieve) with Crawlee running the retrieval legs: RequestQueue dedupes by
// URL (uniqueKey), one crawler run reuses a single browser pool for js
// adapters, politeness spaces consecutive requests. Returns the same
// { landing, raws } shape plus { stats }.

async function crawlViaCrawlee(adapter, options = {}) {
  ensureProcessStorageDir();
  if (!adapter || !Array.isArray(adapter.startUrls) || !adapter.startUrls[0]) {
    throw new Error("crawleeTransport: adapter with startUrls is required");
  }
  const useBrowser = adapter.render === "js";
  const { timeout, retries, delay } = crawlOptsOf(adapter, useBrowser);
  const maxConcurrency =
    typeof options.maxConcurrency === "number" && options.maxConcurrency >= 1
      ? Math.floor(options.maxConcurrency)
      : 1;
  const politeness = createPoliteness(delay);
  const perRequest = [];
  let dedupSkipped = 0;
  let added = 0;

  const timeoutSecs = Math.max(timeout / 1000, 0.1);
  const landingStarted = Date.now();
  const landing = await fetchPageViaCrawlee(adapter.startUrls[0], {
    timeout,
    retries,
    useBrowser,
  });
  perRequest.push({ url: landing.url, kind: "landing", ok: true, attempts: 1, durationMs: landing.stats.perRequest[0].durationMs });

  const data = parseHTML(landing.text);
  const discovered = discoverDocuments(data.links, adapter.docRules, landing.url);

  const raws = [];
  if (discovered.length === 0) {
    return { landing, raws, stats: statsOf(perRequest, { added, dedupSkipped, maxConcurrency, landingMs: Date.now() - landingStarted }) };
  }

  if (!useBrowser) {
    const outcomes = new Map();
    const failures = new Map();
    const crawler = new BasicCrawler({
      requestQueue: await freshQueue(),
      maxRequestsPerCrawl: discovered.length + 2,
      maxConcurrency,
      maxRequestRetries: retries,
      requestHandlerTimeoutSecs: Math.max(timeoutSecs, 60),
      async requestHandler({ request, sendRequest }) {
        await politeness.wait();
        const t0 = Date.now();
        const meta = request.userData.meta;
        try {
          if (meta.type === "PDF") {
            const res = await sendRequest({ url: request.url, responseType: "buffer", timeout: { request: timeout } });
            outcomes.set(request.id, {
              label: meta.label || null,
              url: request.url,
              sourceUrl: meta.sourceUrl || null,
              type: "PDF",
              fetchedAt: new Date(),
              status: res.statusCode,
              contentType: (res.headers && res.headers["content-type"]) || null,
              content: Buffer.from(res.body),
              attempts: (request.retryCount || 0) + 1,
              durationMs: Date.now() - t0,
            });
          } else {
            const res = await sendRequest({ url: request.url, timeout: { request: timeout } });
            const text = typeof res.body === "string" ? res.body : String(res.body);
            outcomes.set(request.id, {
              label: meta.label || null,
              url: request.url,
              sourceUrl: meta.sourceUrl || null,
              type: meta.type || "HTML",
              fetchedAt: new Date(),
              status: res.statusCode,
              contentType: null,
              content: text,
              attempts: (request.retryCount || 0) + 1,
              durationMs: Date.now() - t0,
            });
          }
        } catch (error) {
          throw error;
        }
      },
      async failedRequestHandler({ request, error }) {
        failures.set(request.id, {
          url: request.url,
          attempts: (request.retryCount || 0) + 1,
          message: (error && error.message) || String(error),
        });
      },
    });
    const enqueued = await enqueueSequential(
      crawler,
      discovered.map((meta) => ({ url: meta.url, uniqueKey: meta.url, userData: { meta } }))
    );
    added = enqueued.added;
    dedupSkipped = enqueued.dedupSkipped;
    await crawler.run();
    if (failures.size > 0) {
      const first = [...failures.values()][0];
      throw new Error(`crawleeTransport: GET ${first.url} failed (${first.message})`);
    }
    // Preserve discovery order.
    const byUrl = new Map([...outcomes.values()].map((o) => [o.url, o]));
    for (const meta of discovered) {
      if (byUrl.has(meta.url) && !raws.find((r) => r.url === meta.url)) raws.push(byUrl.get(meta.url));
    }
    for (const o of outcomes.values()) {
      perRequest.push({ url: o.url, kind: "document", ok: true, attempts: o.attempts, durationMs: o.durationMs });
    }
    return { landing, raws, stats: statsOf(perRequest, { added, dedupSkipped, maxConcurrency, landingMs: Date.now() - landingStarted }) };
  }

  // Browser path: one PlaywrightCrawler run; HTML via page.content, PDFs via
  // the download-event capture. userData carries discovery metadata only.
  const outcomes = new Map();
  const failures = new Map();
  const waiters = new Map();
  const crawler = new PlaywrightCrawler({
    requestQueue: await freshQueue(),
    maxRequestsPerCrawl: discovered.length + 2,
    maxConcurrency,
    maxRequestRetries: retries,
    navigationTimeoutSecs: timeoutSecs,
    requestHandlerTimeoutSecs: Math.max(timeoutSecs, 60),
    preNavigationHooks: [
      async ({ page, request }) => {
        await politeness.wait();
        if (request.userData.meta && request.userData.meta.type === "PDF") {
          waiters.set(
            request.id,
            page.waitForEvent("download", { timeout: Math.max(timeout - 1000, 1000) }).catch(() => null)
          );
        }
      },
    ],
    async requestHandler({ request, page, response }) {
      const t0 = Date.now();
      const meta = request.userData.meta;
      if (meta.type === "PDF") {
        const body = response ? await response.body().catch(() => null) : null;
        if (!body) throw new Error("no PDF response body");
        const headers = response ? await response.allHeaders().catch(() => ({})) : {};
        outcomes.set(request.id, {
          label: meta.label || null,
          url: request.url,
          sourceUrl: meta.sourceUrl || null,
          type: "PDF",
          fetchedAt: new Date(),
          status: response ? response.status() : null,
          contentType: headers["content-type"] || null,
          content: Buffer.from(body),
          attempts: (request.retryCount || 0) + 1,
          via: "browser-response",
          durationMs: Date.now() - t0,
        });
        return;
      }
      const text = await page.content();
      outcomes.set(request.id, {
        label: meta.label || null,
        url: page.url() || request.url,
        sourceUrl: meta.sourceUrl || null,
        type: meta.type || "HTML",
        fetchedAt: new Date(),
        status: response ? response.status() : null,
        contentType: null,
        content: text,
        attempts: (request.retryCount || 0) + 1,
        durationMs: Date.now() - t0,
      });
    },
    async failedRequestHandler({ request, error }) {
      const message = (error && error.message) || String(error);
      const meta = (request.userData && request.userData.meta) || {};
      if (meta.type === "PDF" && /download is starting/i.test(message)) {
        const download = await (waiters.get(request.id) || null);
        if (download) {
          const filePath = await download.path().catch(() => null);
          if (filePath) {
            outcomes.set(request.id, {
              label: meta.label || null,
              url: request.url,
              sourceUrl: meta.sourceUrl || null,
              type: "PDF",
              fetchedAt: new Date(),
              status: null,
              contentType: "application/pdf",
              content: fs.readFileSync(filePath),
              attempts: (request.retryCount || 0) + 1,
              via: "browser-download",
            });
            return;
          }
        }
      }
      failures.set(request.id, {
        url: request.url,
        attempts: (request.retryCount || 0) + 1,
        message,
      });
    },
  });
  const enqueuedBrowser = await enqueueSequential(
    crawler,
    discovered.map((meta) => ({ url: meta.url, uniqueKey: meta.url, userData: { meta } }))
  );
  added = enqueuedBrowser.added;
  dedupSkipped = enqueuedBrowser.dedupSkipped;
  await crawler.run();
  if (failures.size > 0) {
    const first = [...failures.values()][0];
    throw new Error(`crawleeTransport: GET ${first.url} failed (${first.message})`);
  }
  const byUrl = new Map([...outcomes.values()].map((o) => [o.url, o]));
  for (const meta of discovered) {
    if (byUrl.has(meta.url) && !raws.find((r) => r.url === meta.url)) raws.push(byUrl.get(meta.url));
  }
  for (const o of outcomes.values()) {
    perRequest.push({ url: o.url, kind: "document", ok: true, attempts: o.attempts, via: o.via, durationMs: o.durationMs || null });
  }
  return { landing, raws, stats: statsOf(perRequest, { added, dedupSkipped, maxConcurrency, landingMs: Date.now() - landingStarted }) };
}

// ------------------------------------------------- mode selection
//
// runWithTransport({ mode, current, crawlee }) — off: current only; shadow:
// current primary + best-effort Crawlee comparison (Crawlee failure never
// rejects); on: Crawlee only (experimental).

async function runWithTransport({ mode, current, crawlee, label } = {}) {
  const resolved = TRANSPORT_MODES.includes(mode) ? mode : getTransportMode();
  if (typeof current !== "function") throw new Error("crawleeTransport: current runner is required");
  if (resolved === "on") {
    if (typeof crawlee !== "function") throw new Error("crawleeTransport: crawlee runner is required for mode on");
    return { primary: "crawlee", mode: resolved, label: label || null, result: await crawlee() };
  }
  const result = await current();
  if (resolved !== "shadow") {
    return { primary: "current", mode: "off", label: label || null, result };
  }
  let shadow = null;
  try {
    shadow = { ok: true, result: typeof crawlee === "function" ? await crawlee() : null };
  } catch (error) {
    shadow = { ok: false, error: (error && error.message) || String(error) };
  }
  return { primary: "current", mode: resolved, label: label || null, result, shadow };
}

module.exports = {
  TRANSPORT_MODES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  BROWSER_TIMEOUT_MS,
  getTransportMode,
  crawlOptsOf,
  fetchPageViaCrawlee,
  fetchBinaryViaCrawlee,
  fetchPdfViaBrowserCrawlee,
  crawlViaCrawlee,
  runWithTransport,
};
