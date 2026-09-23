#!/usr/bin/env node
// =============================================================================
// scraper/benchmarks/crawlBaseline.js — STEP 0 baseline benchmark
// =============================================================================
// WHAT: Measures the CURRENT scraper (Phase 1-29) without changing it.
//   All workloads drive the existing modules (crawlSource, fetchDocument,
//   fetchHTML, fetchBinary, parsePDFBuffer) against isolated local HTTP
//   servers. No Crawlee, no Python, no registry/extraction/publish changes.
//
// SCOPE: instrumentation lives HERE, around the implementation. The scraper
//   under test is imported as-is. MongoDB is intentionally NOT used:
//   crawlSource performs fetch -> parse -> discover -> retrieve with zero DB
//   I/O, so this baseline needs no database (production or test).
//
// RUN (from repository root):
//   node scraper/benchmarks/crawlBaseline.js [--out <path>] [--skip-w1]
//
//   --out <path>  explicit JSON output path (default:
//                 scraper/benchmarks/results/baseline.<UTC timestamp>.json)
//   --skip-w1     skip W1 (JEE Main browser workload) when Playwright
//                 browsers are unavailable; W1 is recorded as "skipped".
//
// WORKLOADS:
//   W1 JEE Main (render:"js", browser) — landing links an Information
//      Bulletin PDF; served locally with the REAL adapter docRules.
//   W2 GATE 2026 (render:"static") — landing links eligibility +
//      important-dates HTML (table dates), REAL docRules.
//   W3 JEE Advanced 2026 (render:"static", matchUrl) — landing uses generic
//      "Link" anchors incl. /documents/IBEnglish_2026.pdf, REAL docRules.
//   F1 retry — server 500s twice then 200; measures attempts/duration.
//   F2 timeout — server delays 1500ms, client timeout 500ms, retries 0.
//   F3 request delay — 2-doc landing with requestDelayMs 300; gap timing.
//   F4 duplicate URL — two docRules match ONE shared URL; counts refetches.
//   P1 PDF round trip — serve tests/fixtures/sample.pdf, fetch + parse.
//
// OUTPUT: JSON results file + human-readable stdout table.
// =============================================================================

const fs = require("fs");
const http = require("http");
const path = require("path");

const { crawlSource } = require("../pipeline/crawlSource");
const { fetchDocument } = require("../fetchers/documentFetcher");
const { fetchHTML, fetchBinary } = require("../fetchers/httpFetcher");
const { parsePDFBuffer } = require("../parsers/pdfParser");
const { SourceAdapterConfigSchema } = require("../registry/schema");
const jeeMainAdapter = require("../registry/exams/jee-main");
const gateAdapter = require("../registry/exams/gate-2026");
const jeeAdvancedAdapter = require("../registry/exams/jee-advanced");

const FIXTURE_PDF = path.join(__dirname, "..", "tests", "fixtures", "sample.pdf");
const RESULTS_DIR = path.join(__dirname, "results");

// ---------------------------------------------------------------- helpers

function nowIso() {
  return new Date().toISOString();
}

function heapBytes() {
  return process.memoryUsage().heapUsed;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Local adapter copy: same REAL docRules/render, startUrls pointed at base. */
function localAdapter(realAdapter, baseUrl) {
  const parsed = SourceAdapterConfigSchema.parse({
    ...realAdapter,
    officialWebsite: `${baseUrl}/`,
    startUrls: [`${baseUrl}/`],
  });
  return parsed;
}

function summarizeRaws(raws) {
  const types = {};
  for (const r of raws) types[r.type] = (types[r.type] || 0) + 1;
  return types;
}

// ---------------------------------------------------------------- W workloads

async function runWebWorkload({ id, name, adapter, landingHtml, routes }) {
  const startedAt = nowIso();
  const startHr = process.hrtime.bigint();
  const memBefore = heapBytes();
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, at: Date.now() });
    const handler = routes[req.url];
    if (handler) {
      res.writeHead(handler.status || 200, handler.headers || { "Content-Type": "text/html" });
      res.end(handler.body);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(landingHtml);
  });
  const baseUrl = await listen(server);
  const usedAdapter = localAdapter(adapter, baseUrl);
  const result = {
    workload: id,
    name,
    mode: usedAdapter.render,
    startUrl: usedAdapter.startUrls[0],
    startedAt,
    pagesFetched: 0,
    documentsDiscovered: 0,
    documentsFetched: 0,
    failedFetches: 0,
    documentTypes: {},
    succeeded: false,
    error: null,
  };
  try {
    const { raws } = await crawlSource(usedAdapter);
    result.pagesFetched = 1 + raws.length;
    result.documentsDiscovered = raws.length;
    result.documentsFetched = raws.length;
    result.documentTypes = summarizeRaws(raws);
    result.succeeded = true;
  } catch (error) {
    result.failedFetches = 1;
    result.succeeded = false;
    result.error = {
      message: error && error.message ? error.message : String(error),
      code: (error && error.code) || null,
    };
  } finally {
    result.endedAt = nowIso();
    result.durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
    result.memory = { heapBefore: memBefore, heapAfter: heapBytes() };
    result.serverHits = hits.length;
    await closeServer(server);
  }
  return result;
}

// ---------------------------------------------------------------- F workloads

async function runF1() {
  const startedAt = nowIso();
  const startHr = process.hrtime.bigint();
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (hits <= 2) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("boom");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>ok</title></head><body><p>recovered</p></body></html>");
  });
  const baseUrl = await listen(server);
  const url = `${baseUrl}/flaky`;
  let succeeded = false;
  let error = null;
  try {
    const meta = { label: "flaky", url, sourceUrl: url, type: "HTML" };
    await fetchDocument(meta, { render: "static", crawl: { maxRetries: 3 } });
    succeeded = true;
  } catch (e) {
    error = e.message;
  }
  const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
  await closeServer(server);
  return {
    workload: "F1", name: "Retry: 2x500 then 200 (maxRetries 3)",
    startedAt, endedAt: nowIso(), attempts: hits,
    finalResult: succeeded ? "success" : "failure",
    durationMs, error,
  };
}

async function runF2() {
  const startedAt = nowIso();
  const startHr = process.hrtime.bigint();
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      try {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body>late</body></html>");
      } catch { /* client already gone */ }
    }, 1500);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  const baseUrl = await listen(server);
  let error = null;
  let errorType = null;
  try {
    await fetchHTML(`${baseUrl}/slow`, { timeout: 500, retries: 0 });
  } catch (e) {
    error = e.message;
    errorType = e.code || (e.response ? `HTTP ${e.response.status}` : "timeout/error");
  }
  const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
  for (const s of sockets) s.destroy();
  await closeServer(server);
  return {
    workload: "F2", name: "Timeout: 1500ms server delay, 500ms client timeout, retries 0",
    startedAt, endedAt: nowIso(),
    timeoutOccurred: error !== null,
    durationMs, errorType, error,
  };
}

async function runF3() {
  const startedAt = nowIso();
  const startHr = process.hrtime.bigint();
  const hitTimes = [];
  const server = http.createServer((req, res) => {
    hitTimes.push(Date.now());
    res.writeHead(200, { "Content-Type": "text/html" });
    if (req.url === "/") {
      res.end(
        "<html><head><title>t</title></head><body>" +
          '<a href="/a.html">Doc alpha</a><a href="/b.html">Doc beta</a></body></html>'
      );
    } else {
      res.end("<html><head><title>doc</title></head><body><p>body text here</p></body></html>");
    }
  });
  const baseUrl = await listen(server);
  const raw = {
    slug: "bench-delay",
    name: "Bench Delay",
    fullForm: "Benchmark Delay Examination",
    conductingBody: "Benchmark Board",
    officialWebsite: `${baseUrl}/`,
    startUrls: [`${baseUrl}/`],
    render: "static",
    docRules: [
      { label: "alpha", match: ["alpha"], type: "HTML" },
      { label: "beta", match: ["beta"], type: "HTML" },
    ],
    crawl: { requestDelayMs: 300 },
  };
  const adapter = SourceAdapterConfigSchema.parse(raw);
  let succeeded = false;
  let error = null;
  try {
    await crawlSource(adapter);
    succeeded = true;
  } catch (e) {
    error = e.message;
  }
  const gaps = [];
  for (let i = 1; i < hitTimes.length; i += 1) gaps.push(hitTimes[i] - hitTimes[i - 1]);
  const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
  await closeServer(server);
  return {
    workload: "F3", name: "Request delay: requestDelayMs 300 between doc fetches",
    startedAt, endedAt: nowIso(), configuredDelayMs: 300,
    observedGapsMs: gaps, serverHits: hitTimes.length,
    succeeded, durationMs, error,
  };
}

async function runF4() {
  const startedAt = nowIso();
  const startHr = process.hrtime.bigint();
  const perPath = {};
  const server = http.createServer((req, res) => {
    perPath[req.url] = (perPath[req.url] || 0) + 1;
    res.writeHead(200, { "Content-Type": "text/html" });
    if (req.url === "/") {
      res.end(
        "<html><head><title>t</title></head><body>" +
          '<a href="/shared.html">Shared document</a></body></html>'
      );
    } else {
      res.end("<html><head><title>shared</title></head><body><p>shared body</p></body></html>");
    }
  });
  const baseUrl = await listen(server);
  const raw = {
    slug: "bench-dupe",
    name: "Bench Dupe",
    fullForm: "Benchmark Duplicate Examination",
    conductingBody: "Benchmark Board",
    officialWebsite: `${baseUrl}/`,
    startUrls: [`${baseUrl}/`],
    render: "static",
    // Two rules intentionally match the SAME link: no dedup exists at the
    // fetch layer, so the shared URL is expected to be fetched twice.
    docRules: [
      { label: "copy-a", match: ["shared document"], type: "HTML" },
      { label: "copy-b", match: ["shared"], type: "HTML" },
    ],
  };
  const adapter = SourceAdapterConfigSchema.parse(raw);
  let discovered = 0;
  let succeeded = false;
  let error = null;
  try {
    const { raws } = await crawlSource(adapter);
    discovered = raws.length;
    succeeded = true;
  } catch (e) {
    error = e.message;
  }
  const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
  await closeServer(server);
  return {
    workload: "F4", name: "Duplicate URL: two rules match one shared link",
    startedAt, endedAt: nowIso(),
    documentsDiscovered: discovered,
    sharedUrlFetches: perPath["/shared.html"] || 0,
    fetchedMoreThanOnce: (perPath["/shared.html"] || 0) > 1,
    succeeded, durationMs, error,
  };
}

// ---------------------------------------------------------------- P1

async function runP1() {
  const startedAt = nowIso();
  const pdfBytes = fs.readFileSync(FIXTURE_PDF);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/pdf" });
    res.end(pdfBytes);
  });
  const baseUrl = await listen(server);
  const out = {
    workload: "P1", name: "PDF round trip: fetch sample.pdf + parsePDFBuffer",
    startedAt, fixtureBytes: pdfBytes.length,
    downloadMs: null, parseMs: null, textLength: null,
    parseSucceeded: false, error: null,
  };
  try {
    const t0 = process.hrtime.bigint();
    const res = await fetchBinary(`${baseUrl}/sample.pdf`, { retries: 0 });
    out.downloadMs = Number(process.hrtime.bigint() - t0) / 1e6;
    out.downloadedBytes = res.buffer.length;
    out.contentType = res.contentType;
    const t1 = process.hrtime.bigint();
    const text = await parsePDFBuffer(res.buffer);
    out.parseMs = Number(process.hrtime.bigint() - t1) / 1e6;
    out.textLength = text.length;
    out.parseSucceeded = true;
  } catch (e) {
    out.error = e.message;
  } finally {
    out.endedAt = nowIso();
    await closeServer(server);
  }
  return out;
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const args = { out: null, skipW1: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out" && argv[i + 1]) args.out = argv[(i += 1)];
    else if (argv[i] === "--skip-w1") args.skipW1 = true;
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scraper/benchmarks/crawlBaseline.js [--out <path>] [--skip-w1]");
    return;
  }
  const runStartedAt = nowIso();
  const pdfBytes = fs.readFileSync(FIXTURE_PDF);
  const pdfHeader = pdfBytes.slice(0, 8).toString("latin1");

  const workloads = {};

  if (args.skipW1) {
    workloads.W1 = { workload: "W1", name: "JEE Main (browser)", skipped: true, reason: "--skip-w1 flag" };
  } else {
    workloads.W1 = await runWebWorkload({
      id: "W1",
      name: "JEE Main (render js via browser, local mirror, REAL docRules)",
      adapter: jeeMainAdapter,
      landingHtml:
        "<html><head><title>JEE Main</title></head><body>" +
        '<a href="/bulletin.pdf">Information Bulletin 2026</a></body></html>',
      routes: {
        "/bulletin.pdf": {
          headers: { "Content-Type": "application/pdf" },
          body: pdfBytes,
        },
      },
    });
  }

  workloads.W2 = await runWebWorkload({
    id: "W2",
    name: "GATE 2026 (static, local mirror, REAL docRules)",
    adapter: gateAdapter,
    landingHtml:
      "<html><head><title>GATE 2026</title></head><body>" +
      '<a href="/eligibility-criteria.html">Eligibility Criteria</a>' +
      '<a href="/important-dates.html">Important Dates</a></body></html>',
    routes: {
      "/eligibility-criteria.html": {
        body:
          "<html><head><title>GATE 2026 Eligibility</title></head><body>" +
          "<h1>Eligibility Criteria</h1>" +
          "<p>Candidates must have completed a Bachelor's degree in Engineering or Technology.</p>" +
          "</body></html>",
      },
      "/important-dates.html": {
        body:
          "<html><head><title>GATE 2026 Dates</title></head><body>" +
          "<h1>Important Dates</h1>" +
          "<table><tr><td>Opening of online application</td><td>August 28, 2025</td></tr>" +
          "<tr><td>Closing Date of online application</td><td>October 07, 2025</td></tr></table>" +
          "</body></html>",
      },
    },
  });

  workloads.W3 = await runWebWorkload({
    id: "W3",
    name: "JEE Advanced 2026 (static + matchUrl, generic Link anchors, REAL docRules)",
    adapter: jeeAdvancedAdapter,
    landingHtml:
      "<html><head><title>JEE Advanced</title></head><body>" +
      '<a href="/documents/keys.pdf">Link</a>' +
      '<a href="/documents/IBEnglish_2026.pdf">Link</a></body></html>',
    routes: {
      "/documents/IBEnglish_2026.pdf": {
        headers: { "Content-Type": "application/pdf" },
        body: pdfBytes,
      },
      "/documents/keys.pdf": {
        headers: { "Content-Type": "application/pdf" },
        body: pdfBytes,
      },
    },
  });

  workloads.F1 = await runF1();
  workloads.F2 = await runF2();
  workloads.F3 = await runF3();
  workloads.F4 = await runF4();
  workloads.P1 = await runP1();

  const results = {
    benchmark: "crawlBaseline",
    step: 0,
    runStartedAt,
    runEndedAt: nowIso(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    notes: [
      "Local-loopback mirrors only; no live exam sites; no MongoDB (crawlSource has no DB I/O).",
      "W1-W3 use REAL registry adapters with startUrls rewritten to 127.0.0.1; docRules/render unchanged.",
      `Fixture PDF ${pdfBytes.length} bytes, header ${JSON.stringify(pdfHeader)}.`,
    ],
    workloads,
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = args.out || path.join(RESULTS_DIR, `baseline.${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const row = (w) => {
    const r = workloads[w];
    if (r.skipped) return `${w}  SKIPPED (${r.reason})`;
    if (w.startsWith("W")) {
      return `${w}  ok=${r.succeeded} mode=${r.mode} pages=${r.pagesFetched} discovered=${r.documentsDiscovered} fetched=${r.documentsFetched} failed=${r.failedFetches} types=${JSON.stringify(r.documentTypes)} ms=${Math.round(r.durationMs)}${r.error ? " err=" + r.error.message : ""}`;
    }
    if (w === "F1") return `F1  attempts=${r.attempts} result=${r.finalResult} ms=${Math.round(r.durationMs)}`;
    if (w === "F2") return `F2  timeout=${r.timeoutOccurred} ms=${Math.round(r.durationMs)} type=${r.errorType}`;
    if (w === "F3") return `F3  gaps=${JSON.stringify(r.observedGapsMs.map(Math.round))} hits=${r.serverHits} ok=${r.succeeded}`;
    if (w === "F4") return `F4  discovered=${r.documentsDiscovered} sharedFetches=${r.sharedUrlFetches} dup=${r.fetchedMoreThanOnce}`;
    if (w === "P1") return `P1  download=${r.downloadMs === null ? "n/a" : Math.round(r.downloadMs) + "ms"} parse=${r.parseMs === null ? "n/a" : Math.round(r.parseMs) + "ms"} chars=${r.textLength} ok=${r.parseSucceeded}${r.error ? " err=" + r.error : ""}`;
    return w;
  };
  console.log("STEP 0 baseline complete:");
  for (const w of ["W1", "W2", "W3", "F1", "F2", "F3", "F4", "P1"]) console.log("  " + row(w));
  console.log(`Results: ${outPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`crawlBaseline failed: ${error && error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
