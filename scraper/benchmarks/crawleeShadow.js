#!/usr/bin/env node
// =============================================================================
// scraper/benchmarks/crawleeShadow.js — STEP 1 shadow comparison
// =============================================================================
// WHAT: Runs every Step 0 workload twice — CURRENT (existing implementation)
//   vs CRAWLEE (fetchers/crawleeTransport.js) — and reports { current,
//   crawlee, diff } per workload. The Step 0 script is NOT modified; fixtures
//   here mirror it (same REAL adapters with startUrls rewritten to 127.0.0.1,
//   same sample.pdf bytes, same fault-injection shapes).
// WHY: Shadow evaluation: the primary (current) result never depends on
//   Crawlee. A Crawlee failure is recorded, never thrown.
// RUN (from repository root):
//   node scraper/benchmarks/crawleeShadow.js [--out <path>]
// OUTPUT: scraper/benchmarks/results/crawlee-shadow.<UTC timestamp>.json
//   (gitignored) + stdout comparison table. No MongoDB (both transports have
//   no DB I/O). No repo writes besides the results file.
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
const {
  fetchPageViaCrawlee,
  fetchBinaryViaCrawlee,
  crawlViaCrawlee,
} = require("../fetchers/crawleeTransport");

const FIXTURE_PDF = path.join(__dirname, "..", "tests", "fixtures", "sample.pdf");
const RESULTS_DIR = path.join(__dirname, "results");

function nowIso() {
  return new Date().toISOString();
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function localAdapter(realAdapter, baseUrl) {
  return SourceAdapterConfigSchema.parse({
    ...realAdapter,
    officialWebsite: `${baseUrl}/`,
    startUrls: [`${baseUrl}/`],
  });
}

function typesOf(raws) {
  const t = {};
  for (const r of raws) t[r.type] = (t[r.type] || 0) + 1;
  return t;
}

async function timed(fn) {
  const memBefore = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  try {
    const value = await fn();
    return { ok: true, value, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, memBefore, memAfter: process.memoryUsage().heapUsed };
  } catch (error) {
    return {
      ok: false,
      error: { message: (error && error.message) || String(error), code: (error && error.code) || null },
      durationMs: Number(process.hrtime.bigint() - t0) / 1e6,
      memBefore,
      memAfter: process.memoryUsage().heapUsed,
    };
  }
}

// ---------------------------------------------------------------- web (W1-W3)

const WEB = {
  W1: {
    name: "JEE Main (render js, bulletin PDF, REAL docRules)",
    adapter: jeeMainAdapter,
    landing:
      "<html><head><title>JEE Main</title></head><body>" +
      '<a href="/bulletin.pdf">Information Bulletin 2026</a></body></html>',
    pdfPaths: ["/bulletin.pdf"],
  },
  W2: {
    name: "GATE 2026 (static, eligibility + dates, REAL docRules)",
    adapter: gateAdapter,
    landing:
      "<html><head><title>GATE 2026</title></head><body>" +
      '<a href="/eligibility-criteria.html">Eligibility Criteria</a>' +
      '<a href="/important-dates.html">Important Dates</a></body></html>',
    routes: {
      "/eligibility-criteria.html":
        "<html><head><title>GATE 2026 Eligibility</title></head><body>" +
        "<h1>Eligibility Criteria</h1>" +
        "<p>Candidates must have completed a Bachelor's degree in Engineering or Technology.</p>" +
        "</body></html>",
      "/important-dates.html":
        "<html><head><title>GATE 2026 Dates</title></head><body>" +
        "<h1>Important Dates</h1>" +
        "<table><tr><td>Opening of online application</td><td>August 28, 2025</td></tr>" +
        "<tr><td>Closing Date of online application</td><td>October 07, 2025</td></tr></table>" +
        "</body></html>",
    },
  },
  W3: {
    name: "JEE Advanced 2026 (static + matchUrl, generic Links, REAL docRules)",
    adapter: jeeAdvancedAdapter,
    landing:
      "<html><head><title>JEE Advanced</title></head><body>" +
      '<a href="/documents/keys.pdf">Link</a>' +
      '<a href="/documents/IBEnglish_2026.pdf">Link</a></body></html>',
    pdfPaths: ["/documents/IBEnglish_2026.pdf", "/documents/keys.pdf"],
  },
};

async function runWeb(id) {
  const spec = WEB[id];
  const pdfBytes = fs.readFileSync(FIXTURE_PDF);

  async function serve() {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push({ url: req.url, at: Date.now() });
      if ((spec.pdfPaths || []).includes(req.url)) {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end(pdfBytes);
        return;
      }
      const route = (spec.routes || {})[req.url];
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(route || spec.landing);
    });
    const base = await listen(server);
    return { server, base, hits };
  }

  // CURRENT side.
  const s1 = await serve();
  const currentAdapter = localAdapter(spec.adapter, s1.base);
  const current = await timed(() => crawlSource(currentAdapter));
  const currentSide = current.ok
    ? {
      succeeded: true, mode: currentAdapter.render,
      pagesFetched: 1 + current.value.raws.length,
      discovered: current.value.raws.length, fetched: current.value.raws.length,
      failed: 0, types: typesOf(current.value.raws), serverHits: s1.hits.length,
      durationMs: current.durationMs, error: null,
    }
    : {
      succeeded: false, mode: currentAdapter.render,
      pagesFetched: 0, discovered: 0, fetched: 0, failed: 1, types: {},
      serverHits: s1.hits.length, durationMs: current.durationMs, error: current.error,
    };
  await close(s1.server);

  // CRAWLEE side (fresh server + fresh adapter so hit counts are comparable).
  const s2 = await serve();
  const crawleeAdapter = localAdapter(spec.adapter, s2.base);
  const crawlee = await timed(() => crawlViaCrawlee(crawleeAdapter));
  const crawleeSide = crawlee.ok
    ? {
      succeeded: true, mode: crawleeAdapter.render,
      pagesFetched: 1 + crawlee.value.raws.length,
      discovered: crawlee.value.raws.length, fetched: crawlee.value.raws.length,
      failed: 0, types: typesOf(crawlee.value.raws), serverHits: s2.hits.length,
      durationMs: crawlee.durationMs, error: null,
      crawleeStats: {
        added: crawlee.value.stats.added, dedupSkipped: crawlee.value.stats.dedupSkipped,
        maxConcurrency: crawlee.value.stats.maxConcurrency,
        totalRetries: crawlee.value.stats.totalRetries,
      },
    }
    : {
      succeeded: false, mode: crawleeAdapter.render,
      pagesFetched: 0, discovered: 0, fetched: 0, failed: 1, types: {},
      serverHits: s2.hits.length, durationMs: crawlee.durationMs, error: crawlee.error,
      crawleeStats: null,
    };
  await close(s2.server);

  // Bytes parity when both sides fetched the same PDFs.
  let bytesEqual = null;
  if (currentSide.succeeded && crawleeSide.succeeded) {
    const curPdfs = current.value.raws.filter((r) => r.type === "PDF").map((r) => r.url).sort();
    const craPdfs = crawlee.value.raws.filter((r) => r.type === "PDF").map((r) => r.url).sort();
    if (curPdfs.length > 0 && curPdfs.length === craPdfs.length) {
      bytesEqual = curPdfs.every((u, i) => {
        const a = current.value.raws.find((r) => r.url === u).content;
        const b = crawlee.value.raws.find((r) => r.url === craPdfs[i]).content;
        return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
      });
    }
  }

  return {
    workload: id,
    name: spec.name,
    current: currentSide,
    crawlee: crawleeSide,
    diff: {
      sameSuccess: currentSide.succeeded === crawleeSide.succeeded,
      sameDiscovered: currentSide.discovered === crawleeSide.discovered,
      sameTypes: JSON.stringify(currentSide.types) === JSON.stringify(crawleeSide.types),
      bytesEqual,
      durationDeltaMs: Math.round(crawleeSide.durationMs - currentSide.durationMs),
    },
  };
}

// ---------------------------------------------------------------- faults

async function runF1() {
  async function serve() {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      if (hits <= 2) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("boom");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><p>recovered</p></body></html>");
    });
    const base = await listen(server);
    return { server, base, hits: () => hits };
  }
  const s1 = await serve();
  const url1 = `${s1.base}/flaky`;
  const c1 = await timed(() =>
    fetchDocument({ label: "flaky", url: url1, sourceUrl: url1, type: "HTML" }, { render: "static", crawl: { maxRetries: 3 } })
  );
  const current = { succeeded: c1.ok, attempts: s1.hits(), durationMs: c1.durationMs, error: c1.ok ? null : c1.error };
  await close(s1.server);

  const s2 = await serve();
  const c2 = await timed(() => fetchPageViaCrawlee(`${s2.base}/flaky`, { timeout: 10000, retries: 3 }));
  const crawlee = {
    succeeded: c2.ok, attempts: s2.hits(), durationMs: c2.durationMs, error: c2.ok ? null : c2.error,
    crawleeStats: c2.ok ? c2.value.stats : null,
  };
  await close(s2.server);
  return {
    workload: "F1", name: "Retry: 2x500 then 200 (maxRetries 3)", current, crawlee,
    diff: { sameSuccess: current.succeeded === crawlee.succeeded, sameAttempts: current.attempts === crawlee.attempts },
  };
}

async function runF2() {
  const sockets = new Set();
  async function serve() {
    const server = http.createServer((req, res) => {
      setTimeout(() => {
        try {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body>late</body></html>");
        } catch { /* client gone */ }
      }, 1500);
    });
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    const base = await listen(server);
    return { server, base };
  }
  const s1 = await serve();
  const c1 = await timed(() => fetchHTML(`${s1.base}/slow`, { timeout: 500, retries: 0 }));
  const current = { timeoutOccurred: !c1.ok, durationMs: c1.durationMs, error: c1.ok ? null : c1.error };
  for (const s of sockets) s.destroy();
  await close(s1.server);

  const s2 = await serve();
  const c2 = await timed(() => fetchPageViaCrawlee(`${s2.base}/slow`, { timeout: 500, retries: 0 }));
  const crawlee = { timeoutOccurred: !c2.ok, durationMs: c2.durationMs, error: c2.ok ? null : c2.error };
  for (const s of sockets) s.destroy();
  await close(s2.server);
  return {
    workload: "F2", name: "Timeout: 1500ms delay, 500ms timeout, retries 0", current, crawlee,
    diff: { sameTimeout: current.timeoutOccurred === crawlee.timeoutOccurred },
  };
}

async function runF3() {
  async function serve() {
    const times = [];
    const server = http.createServer((req, res) => {
      times.push(Date.now());
      res.writeHead(200, { "Content-Type": "text/html" });
      if (req.url === "/") {
        res.end('<html><head><title>t</title></head><body><a href="/a.html">Doc alpha</a><a href="/b.html">Doc beta</a></body></html>');
      } else {
        res.end("<html><head><title>doc</title></head><body><p>body text here</p></body></html>");
      }
    });
    const base = await listen(server);
    return { server, base, times };
  }
  function adapterFor(base) {
    return SourceAdapterConfigSchema.parse({
      slug: "bench-delay", name: "Bench Delay", fullForm: "Benchmark Delay Examination",
      conductingBody: "Benchmark Board", officialWebsite: `${base}/`, startUrls: [`${base}/`],
      render: "static",
      docRules: [
        { label: "alpha", match: ["alpha"], type: "HTML" },
        { label: "beta", match: ["beta"], type: "HTML" },
      ],
      crawl: { requestDelayMs: 300 },
    });
  }
  const s1 = await serve();
  const c1 = await timed(() => crawlSource(adapterFor(s1.base)));
  const gaps1 = s1.times.slice(1).map((t, i) => t - s1.times[i]);
  const current = { succeeded: c1.ok, configuredDelayMs: 300, observedGapsMs: gaps1, hits: s1.times.length, durationMs: c1.durationMs };
  await close(s1.server);

  const s2 = await serve();
  const c2 = await timed(() => crawlViaCrawlee(adapterFor(s2.base)));
  const gaps2 = s2.times.slice(1).map((t, i) => t - s2.times[i]);
  const crawlee = {
    succeeded: c2.ok, configuredDelayMs: 300, observedGapsMs: gaps2, hits: s2.times.length,
    durationMs: c2.durationMs, error: c2.ok ? null : c2.error,
  };
  await close(s2.server);
  return {
    workload: "F3", name: "Request delay: requestDelayMs 300", current, crawlee,
    diff: {
      sameSuccess: current.succeeded === crawlee.succeeded,
      crawleeGapsHonorDelay: gaps2.filter((g) => g >= 250).length === gaps2.length && gaps2.length > 0,
    },
  };
}

async function runF4() {
  async function serve() {
    const perPath = {};
    const server = http.createServer((req, res) => {
      perPath[req.url] = (perPath[req.url] || 0) + 1;
      res.writeHead(200, { "Content-Type": "text/html" });
      if (req.url === "/") {
        res.end('<html><head><title>t</title></head><body><a href="/shared.html">Shared document</a></body></html>');
      } else {
        res.end("<html><head><title>s</title></head><body><p>shared</p></body></html>");
      }
    });
    const base = await listen(server);
    return { server, base, perPath };
  }
  function adapterFor(base) {
    return SourceAdapterConfigSchema.parse({
      slug: "bench-dupe", name: "Bench Dupe", fullForm: "Benchmark Duplicate Examination",
      conductingBody: "Benchmark Board", officialWebsite: `${base}/`, startUrls: [`${base}/`],
      render: "static",
      docRules: [
        { label: "copy-a", match: ["shared document"], type: "HTML" },
        { label: "copy-b", match: ["shared"], type: "HTML" },
      ],
    });
  }
  const s1 = await serve();
  const c1 = await timed(() => crawlSource(adapterFor(s1.base)));
  const current = {
    succeeded: c1.ok, discovered: c1.ok ? c1.value.raws.length : 0,
    sharedFetches: s1.perPath["/shared.html"] || 0, durationMs: c1.durationMs,
  };
  await close(s1.server);

  const s2 = await serve();
  const c2 = await timed(() => crawlViaCrawlee(adapterFor(s2.base)));
  const crawlee = {
    succeeded: c2.ok, discovered: c2.ok ? c2.value.raws.length : 0,
    sharedFetches: s2.perPath["/shared.html"] || 0, durationMs: c2.durationMs,
    error: c2.ok ? null : c2.error,
    crawleeStats: c2.ok ? { added: c2.value.stats.added, dedupSkipped: c2.value.stats.dedupSkipped } : null,
  };
  await close(s2.server);
  return {
    workload: "F4", name: "Duplicate URL: two rules match one link", current, crawlee,
    diff: { crawleeDeduped: crawlee.sharedFetches === 1 && current.sharedFetches > 1 },
  };
}

async function runP1() {
  const pdfBytes = fs.readFileSync(FIXTURE_PDF);
  async function serve() {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(pdfBytes);
    });
    const base = await listen(server);
    return { server, base };
  }
  const s1 = await serve();
  const c1 = await timed(async () => {
    const t0 = process.hrtime.bigint();
    const res = await fetchBinary(`${s1.base}/sample.pdf`, { retries: 0 });
    const downloadMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const t1 = process.hrtime.bigint();
    let textLength = null;
    let parseSucceeded = false;
    let parseError = null;
    try {
      const text = await parsePDFBuffer(res.buffer);
      textLength = text.length;
      parseSucceeded = true;
    } catch (e) {
      parseError = e.message;
    }
    return { downloadMs, downloadedBytes: res.buffer.length, parseMs: Number(process.hrtime.bigint() - t1) / 1e6, textLength, parseSucceeded, parseError, buffer: res.buffer };
  });
  const current = c1.ok
    ? { downloadMs: c1.value.downloadMs, parseSucceeded: c1.value.parseSucceeded, textLength: c1.value.textLength, parseError: c1.value.parseError, durationMs: c1.durationMs, error: null, bytes: c1.value.buffer }
    : { durationMs: c1.durationMs, error: c1.error, bytes: null };
  await close(s1.server);

  const s2 = await serve();
  const c2 = await timed(async () => {
    const t0 = process.hrtime.bigint();
    const res = await fetchBinaryViaCrawlee(`${s2.base}/sample.pdf`, { timeout: 15000, retries: 0 });
    const downloadMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const t1 = process.hrtime.bigint();
    let textLength = null;
    let parseSucceeded = false;
    let parseError = null;
    try {
      const text = await parsePDFBuffer(res.buffer);
      textLength = text.length;
      parseSucceeded = true;
    } catch (e) {
      parseError = e.message;
    }
    return { downloadMs, downloadedBytes: res.buffer.length, parseMs: Number(process.hrtime.bigint() - t1) / 1e6, textLength, parseSucceeded, parseError, buffer: res.buffer };
  });
  const crawlee = c2.ok
    ? { downloadMs: c2.value.downloadMs, parseSucceeded: c2.value.parseSucceeded, textLength: c2.value.textLength, parseError: c2.value.parseError, durationMs: c2.durationMs, error: null, bytes: c2.value.buffer }
    : { durationMs: c2.durationMs, error: c2.error, bytes: null };
  await close(s2.server);

  const bytesEqual =
    current.bytes && crawlee.bytes ? Buffer.from(current.bytes).equals(Buffer.from(crawlee.bytes)) : null;
  delete current.bytes;
  delete crawlee.bytes;
  return {
    workload: "P1", name: "PDF round trip: fetch sample.pdf + parsePDFBuffer", current, crawlee,
    diff: { bytesEqual, sameParseOutcome: current.parseSucceeded === crawlee.parseSucceeded },
  };
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const args = { out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out" && argv[i + 1]) args.out = argv[(i += 1)];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scraper/benchmarks/crawleeShadow.js [--out <path>]");
    return;
  }
  const runStartedAt = nowIso();
  const workloads = {};
  for (const id of ["W1", "W2", "W3"]) {
    workloads[id] = await runWeb(id);
  }
  workloads.F1 = await runF1();
  workloads.F2 = await runF2();
  workloads.F3 = await runF3();
  workloads.F4 = await runF4();
  workloads.P1 = await runP1();

  const results = {
    benchmark: "crawleeShadow",
    step: 1,
    mode: "shadow",
    runStartedAt,
    runEndedAt: nowIso(),
    baseline: "scraper/benchmarks/results/baseline.2026-09-23T05-29-07-563Z.json",
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    notes: [
      "CURRENT = existing implementation (crawlSource/fetchDocument/fetchHTML/fetchBinary).",
      "CRAWLEE = fetchers/crawleeTransport.js (RequestQueue dedup, deterministic politeness, browser-download capture).",
      "Local-loopback mirrors only; no live sites; no MongoDB; Step 0 script untouched.",
    ],
    workloads,
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = args.out || path.join(RESULTS_DIR, `crawlee-shadow.${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const row = (w) => {
    const r = workloads[w];
    const c = r.current;
    const k = r.crawlee;
    const cs = c.succeeded !== undefined ? `cur ok=${c.succeeded}` : `cur timeout=${c.timeoutOccurred}`;
    const ks = k.succeeded !== undefined ? `craw ok=${k.succeeded}` : `craw timeout=${k.timeoutOccurred}`;
    const extra =
      w === "F4"
        ? ` curFetches=${c.sharedFetches} crawFetches=${k.sharedFetches}`
        : w.startsWith("W")
          ? ` cur=${c.discovered}/${JSON.stringify(c.types)} craw=${k.discovered}/${JSON.stringify(k.types)}`
          : w === "F1"
            ? ` curAttempts=${c.attempts} crawAttempts=${k.attempts}`
            : w === "F3"
              ? ` curGaps=${JSON.stringify(c.observedGapsMs.map(Math.round))} crawGaps=${JSON.stringify(k.observedGapsMs.map(Math.round))}`
              : w === "P1"
                ? ` bytesEqual=${r.diff.bytesEqual}`
                : "";
    return `${w}  ${cs} ${ks}${extra} dMs=${Math.round((k.durationMs || 0) - (c.durationMs || 0))}`;
  };
  console.log("STEP 1 shadow comparison complete:");
  for (const w of ["W1", "W2", "W3", "F1", "F2", "F3", "F4", "P1"]) console.log("  " + row(w));
  console.log(`Results: ${outPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`crawleeShadow failed: ${error && error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
