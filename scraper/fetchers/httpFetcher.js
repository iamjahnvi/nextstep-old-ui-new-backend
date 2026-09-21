// =============================================================================
// scraper/fetchers/httpFetcher.js
// =============================================================================
// WHAT: Generic HTTP fetcher for static pages. No exam knowledge here.
// WHY: Every adapter needs the same plumbing — timeout, user-agent, redirect
//   handling, basic retry, relative-URL resolution. One shared implementation
//   instead of ad-hoc axios calls per scraper.
// CONTRACT:
//   fetchHTML(url, opts) -> Promise<{ url, text, status }>
//     url    : final URL after redirects (or the resolved target if the server
//              hides it). Relative inputs are resolved against opts.baseUrl.
//     text   : response body as string.
//     status : HTTP status code.
//   resolveUrl(url, baseUrl) -> absolute URL string (WHATWG URL resolution).
// =============================================================================

const axios = require("axios");

const DEFAULT_USER_AGENT =
  "NextStepScraper/0.1 (+exam-discovery; contact via official site)";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolve a possibly-relative URL against a base (page URL). Absolute URLs
// pass through unchanged. Throws a clear error on invalid input.
function resolveUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).toString();
  } catch (error) {
    throw new Error(
      `httpFetcher: cannot resolve URL "${url}"` +
        (baseUrl ? ` against base "${baseUrl}"` : "") +
        `: ${error.message}`
    );
  }
}

// Retryable: network errors (no response), timeouts, 429 and 5xx.
// NOT retried: other 4xx (the request itself is wrong; retrying won't help).
function isRetryable(error, attempt, maxRetries) {
  if (attempt >= maxRetries) return false;
  const status = error && error.response && error.response.status;
  if (status === undefined || status === null) return true; // network/timeout
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

async function fetchHTML(url, options = {}) {
  const {
    baseUrl,
    timeout = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    userAgent = DEFAULT_USER_AGENT,
  } = options;

  const target = resolveUrl(url, baseUrl);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await axios.get(target, {
        timeout,
        responseType: "text",
        maxRedirects: 5,
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html,application/xhtml+xml",
        },
        validateStatus: (status) => status >= 200 && status < 400,
      });

      const finalUrl =
        (response.request &&
          response.request.res &&
          response.request.res.responseUrl) ||
        target;

      const text =
        typeof response.data === "string"
          ? response.data
          : String(response.data);

      return { url: finalUrl, text, status: response.status };
    } catch (error) {
      lastError = error;
      if (!isRetryable(error, attempt, retries)) break;
      await sleep(retryDelayMs * (attempt + 1)); // linear backoff
    }
  }

  const detail =
    lastError && lastError.response
      ? `HTTP ${lastError.response.status}`
      : (lastError && lastError.code) || (lastError && lastError.message);
  throw new Error(`httpFetcher: GET ${target} failed (${detail})`);
}

// Binary twin of fetchHTML for non-text documents (PDFs). Same plumbing —
// timeout, user-agent, redirects, basic retry — but returns raw bytes so the
// PDF parser receives an unmodified buffer (never transcoded to text).
// fetchBinary(url, opts) -> Promise<{ url, status, buffer, contentType }>
async function fetchBinary(url, options = {}) {
  const {
    baseUrl,
    timeout = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    userAgent = DEFAULT_USER_AGENT,
  } = options;

  const target = resolveUrl(url, baseUrl);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await axios.get(target, {
        timeout,
        responseType: "arraybuffer",
        maxRedirects: 5,
        headers: {
          "User-Agent": userAgent,
          Accept: "*/*",
        },
        validateStatus: (status) => status >= 200 && status < 400,
      });

      const finalUrl =
        (response.request &&
          response.request.res &&
          response.request.res.responseUrl) ||
        target;

      return {
        url: finalUrl,
        status: response.status,
        buffer: Buffer.from(response.data),
        contentType: response.headers["content-type"] || null,
      };
    } catch (error) {
      lastError = error;
      if (!isRetryable(error, attempt, retries)) break;
      await sleep(retryDelayMs * (attempt + 1)); // linear backoff
    }
  }

  const detail =
    lastError && lastError.response
      ? `HTTP ${lastError.response.status}`
      : (lastError && lastError.code) || (lastError && lastError.message);
  throw new Error(`httpFetcher: GET ${target} failed (${detail})`);
}

module.exports = {
  fetchHTML,
  fetchBinary,
  resolveUrl,
  sleep,
  DEFAULT_USER_AGENT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
};
