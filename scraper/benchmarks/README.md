# STEP 0 — Scraper Baseline Benchmark

Measures the CURRENT scraper (Phase 1–29) without changing it. No Crawlee, no Python, no behavior changes.

## How to run

From the repository root (`nextstep-old-ui-new-backend/`):

```text
node scraper/benchmarks/crawlBaseline.js
node scraper/benchmarks/crawlBaseline.js --out scraper/benchmarks/results/baseline.custom.json
node scraper/benchmarks/crawlBaseline.js --skip-w1
```

* `--out <path>` — explicit JSON output path.
* `--skip-w1` — skip the JEE Main browser workload (use when Playwright browsers are not installed). W1 is recorded as `skipped` instead of failing the run.
* Requires `npm install` in `scraper/` (uses `axios`, `cheerio`, `playwright`, `pdf-parse` already in `scraper/package.json`). No new dependencies.
* Uses no MongoDB: `pipeline/crawlSource.js` performs fetch → parse → discover → retrieve with zero DB I/O. Production and test databases are untouched.

Output: `scraper/benchmarks/results/baseline.<UTC-timestamp>.json` (gitignored — see below) plus a stdout summary table.

## Workloads

| ID | Meaning |
|---|---|
| W1 | JEE Main — REAL adapter (`registry/exams/jee-main.js`, `render:"js"`, browser) against a local mirror: landing links an Information Bulletin PDF served from `tests/fixtures/sample.pdf`. Exercises Playwright launch + binary PDF retrieval. |
| W2 | GATE 2026 — REAL adapter (`render:"static"`) against a local mirror: landing links `eligibility-criteria.html` + `important-dates.html` (table dates). Exercises static fetch + multi-doc discovery. |
| W3 | JEE Advanced 2026 — REAL adapter (`render:"static"`, `matchUrl:["IBEnglish"]`) against a local mirror with generic `"Link"` anchors (`/documents/IBEnglish_2026.pdf` + decoy). Exercises URL-substring discovery. |
| F1 | Retry — local server returns 500 twice then 200; client `maxRetries: 3`. Expect `attempts: 3`, `finalResult: success`. |
| F2 | Timeout — local server delays 1500ms; client `timeout: 500`, `retries: 0`. Expect `timeoutOccurred: true`, `durationMs ≈ 500`. |
| F3 | Request delay — 2-doc landing with `requestDelayMs: 300`. Expect inter-request gaps ≈ 300ms. |
| F4 | Duplicate URL — two `docRules` match ONE shared link. Current code has no fetch-layer dedup, so `sharedUrlFetches: 2` documents existing behavior. |
| P1 | PDF round trip — serve `tests/fixtures/sample.pdf` (311 bytes), `fetchBinary` + `parsePDFBuffer`. Records download/parse time, text length, success. |

W1–W3 use REAL registry adapters with ONLY `officialWebsite`/`startUrls` rewritten to `127.0.0.1`; `docRules`/`render`/vocabularies are unchanged.

## Metrics

* Web (W1–W3): `mode`, `startUrl`, `startedAt/endedAt/durationMs`, `pagesFetched` (landing + docs), `documentsDiscovered`, `documentsFetched`, `failedFetches`, `documentTypes` (`{HTML:n, PDF:n}`), `succeeded`, `error{message,code}`, `serverHits`, `memory{heapBefore,heapAfter}`.
* F1: `attempts`, `finalResult`, `durationMs`. F2: `timeoutOccurred`, `durationMs`, `errorType`. F3: `configuredDelayMs`, `observedGapsMs`, `serverHits`. F4: `documentsDiscovered`, `sharedUrlFetches`, `fetchedMoreThanOnce`. P1: `fixtureBytes`, `downloadMs`, `downloadedBytes`, `contentType`, `parseMs`, `textLength`, `parseSucceeded`.
* Envelope: `environment{node,platform,arch}`, `runStartedAt/EndedAt`, `notes`.

## Known limitations

1. Local mirrors replicate official STRUCTURE (link shapes, table markup, generic anchors), not live content, volume, or bot defenses (NTA 403/CDN behavior is not reproduced).
2. W1 measures one browser launch against a trivial page — a lower bound on real Playwright overhead, not a production timing.
3. `sample.pdf` is a 311-byte binary-integrity fixture (header + byte soup, used by round-trip/checksum tests — never parsed by them), not a 6MB bulletin — P1 validates fetch + parse plumbing and is EXPECTED to record `parseSucceeded: false` (`Invalid PDF structure`) on this fixture, not large-PDF throughput.
4. Observed 2026-09-23: `fetchBinaryViaBrowser` fails on a PDF served as a Chromium download (`page.goto: Download is starting`), so W1 records a failed scrape with that error. The landing HTML fetch itself succeeds; the failure is on the browser-PDF leg — preserved here as the factual baseline.
5. Mongo staging/drift, extraction quality, and review/publish are NOT benchmarked here; they are covered by the existing test suite (`npm test` in `scraper/`). This script is intentionally DB-free.
6. Timings are loopback-local and machine-dependent — compare runs on the same host.

## Comparing future benchmarks (Crawlee / Python)

1. Re-run this script unchanged to refresh the baseline on the comparison host.
2. The candidate (Crawlee transport, Python doc processing) must reproduce a NEW results file with the same workload IDs and metric names.
3. Gate: identical `documentsDiscovered/documentsFetched/documentTypes/finalResult` on W1–W4/F1–P1, `observedGapsMs` ≥ configured delay, F2 timeout preserved, full `npm test` green, with `durationMs`/memory reported side-by-side. Any behavior delta (e.g. browser-pool speedup, dedup changing F4) must be an explicit, flagged improvement — never a silent change.
