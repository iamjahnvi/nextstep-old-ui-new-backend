# STEP 22 Report — Adapter-Declared Bulletin URL Allowlist

Bounded probe, never a crawler. No extraction, review, publish, transport,
or decision-logic changes (`httpFetcher`, `browserFetcher`,
`crawleeTransport` byte-identical). Live run used an isolated staging
database; zero production writes, zero publishes. Raw run JSON:
`pilot/results/step22-jeemain.*.json` (gitignored).

## Allowlist design

- Adapter field: `bulletinUrls` (new, optional, `z.array(z.url())`,
  `MAX_BULLETIN_URLS = 5`, default `[]`) on the strict adapter schema —
  shared constant with the probe so the bounds cannot drift. Empty by
  default: no declaration means no candidates.
- Precedence: normal discovery → Step 21 observed-link fallback → Step 22
  allowlist, each gated on still having no bulletin/adapter-matched
  document. Static adapters with declarations probe over HTTP; js adapters
  over the pooled browser with download capture (Step 20 selector, reused).
- Validation reuses the shared document gate: reachable alone never
  validates — PDFs need non-empty bytes with %PDF magic or pdf content-type,
  HTML needs an adapter-rule hit on the final URL. Declaration is explicit
  operator trust (exempting same-domain-only), but never exempts https
  (loopback excepted for tests), reachability, or validity.
- Every attempt records url, `adapter-allowlist` source, reachability,
  acceptance, reason, bytes, content-type; failures are per-URL and never
  throw. `stages.allowlist` joins `stages.fallback` in Step 9 output.

## Regression (9 tests, all passing)

Exact-URL probing with zero variants; over-cap truncation to the first 5;
invalid documents rejected despite declaration; per-URL failure isolation;
unparseable + cleartext-off-loopback refused without fetching; precedence
gating (present bulletin, accepted fallback, missing/empty declarations);
js→browser vs static→HTTP transport proof on a local server; no exam names,
no hardcoded bulletin paths.

## JEE Main live re-test (`jee-main`, `render: "js"`, 57 s)

- Browser accessibility: landing 200 via pooled browser (plain HTTP still
  403); normal discovery found notices/syllabus pages but no bulletin;
  Step 21 fallback correctly returned `empty` (no same-domain PDFs exposed —
  the 49 landing PDFs live on the `cdnbbsr.s3waas.gov.in` CDN host).
- **ALLOWLIST CONFIGURED** (one URL): the Nov-2025 "Information Bulletin"
  link observed live on the authoritative landing, recorded with provenance
  in the adapter (stale Oct-2024 URL deliberately excluded).
  - **URL PROBED** exactly as declared (no variants attempted).
  - **TRANSPORT USED**: pooled browser (js adapter).
  - **PDF CAPTURED**: 6,092,568 bytes, `application/pdf`, `%PDF-1.7` magic —
    the Step 1 download capture working live against the real CDN. (Crawlee
    logged one retry-exhaustion ERROR line for the same URL; bytes verified
    intact regardless — log noise with no data impact, noted for follow-up.)
- **DOCUMENT VERIFIED**: yes — fetched, staged, parsed (~124K chars across
  5 sources), extracted with evidence; registration nulls honest (notices
  carry no window); education Graduate/MEDIUM and subjects incl. Biology
  flagged investigate (boilerplate-adjacent matches, never auto-accepted).
- Downstream: validation ok → review REQUIRED (5 review-required, 2
  insufficient, 0 auto-acceptable) → draft `DRAFT`, unpublished, 0 writes.
  Operator verdict: PASS_WITH_REVIEW.

## Separated claims

- TRANSPORT VERIFIED · DISCOVERY FALLBACK VERIFIED (Step 21 empty-case) ·
  SOURCE ACCESS VERIFIED (landing + HTML + CDN bulletin all live) ·
  DOCUMENT VERIFIED (6 MB PDF captured, magic + content-type confirmed,
  parsed, extracted with evidence) · PIPELINE VERIFIED (seam only).

## Remaining limitations → recommended Step 23

CDN-host rotation would orphan the declared URL (re-verify per cycle);
Crawlee's retry-exhaustion ERROR log on successful download capture deserves
a look; bulletin content review (Biology anomaly) is operator work.
Recommended Step 23 (observed-only): allowlist freshness check — re-probe
declared URLs on a schedule and flag rotation to the operator, no crawling.
