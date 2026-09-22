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
// axios is used for html parsing.

const DEFAULT_USER_AGENT =

  "NextStepScraper/0.1 (+exam-discovery; contact via official site)";

  // Tells the website who is making the request.
  // Instead of pretending to be Chrome, your scraper identifies itself as: NextStepScraper/0.1
  // The +exam-discovery and contact text gives additional context.

const DEFAULT_TIMEOUT_MS = 15000;
// Maximum time to wait for a request.

const DEFAULT_RETRIES = 2;
// If a request fails, the scraper can try again 2 more times.
// So: initial request → fails → retry 1 → fails → retry 2

const DEFAULT_RETRY_DELAY_MS = 800;
// How long to wait before retrying, 800 ms = 0.8 seconds.
// So after a failed request: fail → wait 0.8 sec → retry

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ms → number of milliseconds to wait.
// setTimeout(resolve, ms) → tells JavaScript: wait ms milliseconds, then call resolve().
// Resolve a possibly-relative URL against a base (page URL). Absolute URLs
// pass through unchanged. Throws a clear error on invalid input.
function resolveUrl(url, baseUrl) {
  // url → the link you want to fetch.
  // url = /documents/bulletin.pdf

 // baseUrl → the original webpage URL used to complete a relative link.
//  baseUrl = https://jeemain.nta.nic.in/
  try {
    return new URL(url, baseUrl).toString();
    // Take url, resolve it using baseUrl, and return the resulting full URL as a string.

  } catch (error) {
    throw new Error(
      `httpFetcher: cannot resolve URL "${url}"` +
        (baseUrl ? ` against base "${baseUrl}"` : "") +
        `: ${error.message}`
        // tells failure reason.
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
  // options = {} means options are optional.
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
// +++++++++++++++++++++++++++++++++++++++++++++++++++++++++

// CONCLUSION :-

// 1  -----------------------------------------------------
// httpsFecther.js inside folder named as fetcher is scraper's website downloader.
// Given a URL → safely fetch the webpage/PDF → handle timeouts, retries, redirects, and errors → return the content.

// const axios = require("axios");
// Axios actually makes the HTTP request.

// Then the DEFAULT_* constants define the default:
// identity → User-Agent
// timeout → 15 sec
// retries → 2
// retry delay → 800 ms

// 2 -------------------------------------------------------

// function sleep(ms) { ... }
// pause before retrying.
// request fails -> wait 800ms -> try again

// 3 ------------------------------------------------------
// resolveUrl(url, baseUrl)

// Turns relative links into complete URLs.
// /documents/bulletin.pdf
//         +
// https://jeemain.nta.nic.in/
//         ↓
// https://jeemain.nta.nic.in/documents/bulletin.pdf

// 4 -----------------------------------------------------
// isRetryable() is the function which decides "should i try this request again?"
// Retries : network errors, timeout, 429, 5xx

// 5 -----------------------------------------------------
// fetchHTML() : main webpage fetcher
// when we do fetchHTML(url) , it does, 
// URL
//  ↓
// resolve URL
//  ↓
// send HTTP GET using Axios
//  ↓
// wait for response
//  ↓
// if successful → return HTML
//  ↓
// if retryable failure → wait → retry
//  ↓
// if final failure → throw error

// it returns : 
// {
//   url,
//   text,
//   status
// }

// 6 -----------------------------------------------------
// fetchBinary() — PDF/file fetcher
// Almost the same machinery as fetchHTML(), but responseType: "arraybuffer" which means: “Give me the raw file bytes, don't treat this as text.”

// That's necessary for PDFs.
// It returns:
// {
//   url,
//   status,
//   buffer,
//   contentType
// }

// Then your PDF parser can take that buffer and actually read the PDF.

// ---------------------------------------------------------
//              httpFetcher.js

// URL ──────────────┐
//                   ↓
//              resolveUrl
//                   ↓
//               Axios
//                   ↓
//         ┌─────────┴─────────┐
//         ↓                   ↓
//    fetchHTML           fetchBinary
//         ↓                   ↓
//    HTML text           PDF bytes
//         ↓                   ↓
//    HTML parser          PDF parser

// `httpFetcher.js = the layer responsible for getting stuff from the internet reliably.