// =============================================================================
// scraper/fetchers/browserFetcher.js
// =============================================================================
// WHAT: Generic browser fetcher for JS-rendered / bot-filtered pages. No exam
//   knowledge here. Second fetch strategy alongside httpFetcher.js, which stays
//   the default — this one is used ONLY when an adapter declares render: "js".
// WHY: Some official sites (e.g. JEE Main) return HTTP 403 to plain HTTP
//   clients. A real Chromium (Playwright) renders the page like a browser and
//   returns the resulting HTML, so the SAME downstream flow (parse → discovery
//   → validation) works unchanged.
// CONTRACT (same as httpFetcher):
//   fetchViaBrowser(url, opts) -> Promise<{ url, text, status }>
//     url    : final page URL after navigation/redirects. Relative inputs are
//              resolved against opts.baseUrl.
//     text   : rendered HTML (page.content()).
//     status : HTTP status of the navigation response. Non-2xx/3xx throws,
//              matching httpFetcher behaviour (no silent error pages downstream).
// =============================================================================

const { chromium } = require("playwright");
const { resolveUrl } = require("./httpFetcher");

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_WAIT_UNTIL = "domcontentloaded";

async function fetchViaBrowser(url, options = {}) {
  const {
    baseUrl,
    timeout = DEFAULT_TIMEOUT_MS,
    waitUntil = DEFAULT_WAIT_UNTIL,
    userAgent = DEFAULT_USER_AGENT,
    headless = true,
  } = options;

  const target = resolveUrl(url, baseUrl);
  let browser = null;

  try {
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({ userAgent });
    const page = await context.newPage();

    const response = await page.goto(target, {
      timeout,
      waitUntil,
    });

    // Page must be usable before we read it: a <body> means the DOM rendered.
    await page.waitForSelector("body", { timeout });

    const status = response ? response.status() : null;
    if (status !== null && (status < 200 || status >= 400)) {
      throw new Error(`HTTP ${status}`);
    }

    const text = await page.content();
    return { url: page.url() || target, text, status };
  } catch (error) {
    throw new Error(
      `browserFetcher: GET ${target} failed (${error.message})`
    );
  } finally {
    // Reliable cleanup: the run never leaks a browser process.
    if (browser) await browser.close();
  }
}

// Binary twin of fetchViaBrowser for non-text documents (PDFs). No DOM is
// involved — the navigation response bytes are returned raw via
// response.body(), so the PDF parser receives an unmodified buffer.
// fetchBinaryViaBrowser(url, opts) -> Promise<{ url, status, buffer, contentType }>
async function fetchBinaryViaBrowser(url, options = {}) {
  const {
    baseUrl,
    timeout = DEFAULT_TIMEOUT_MS,
    waitUntil = DEFAULT_WAIT_UNTIL,
    userAgent = DEFAULT_USER_AGENT,
    headless = true,
  } = options;

  const target = resolveUrl(url, baseUrl);
  let browser = null;

  try {
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({ userAgent });
    const page = await context.newPage();

    const response = await page.goto(target, {
      timeout,
      waitUntil,
    });

    if (!response) {
      throw new Error("no navigation response");
    }
    const status = response.status();
    if (status < 200 || status >= 400) {
      throw new Error(`HTTP ${status}`);
    }

    const body = await response.body();
    const headers = await response.allHeaders();
    return {
      url: page.url() || target,
      status,
      buffer: Buffer.from(body),
      contentType: headers["content-type"] || null,
    };
  } catch (error) {
    throw new Error(
      `browserFetcher: GET ${target} failed (${error.message})`
    );
  } finally {
    // Reliable cleanup: the run never leaks a browser process.
    if (browser) await browser.close();
  }
}

module.exports = {
  fetchViaBrowser,
  fetchBinaryViaBrowser,
  DEFAULT_TIMEOUT_MS,
};
