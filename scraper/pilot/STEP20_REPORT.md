# STEP 20 Report — Browser Transport Selection + JEE Main Re-test

Integration fix, not a redesign. Live runs used isolated staging databases;
zero production writes, zero publishes. Raw run JSON: `pilot/results/`
(`step20-jeemain.*.json`, gitignored).

## Transport integration

Previous behavior: `discoverFromSource` hardcoded `fetchHTML` as its default
page fetcher, and Step 9 passed no adapter context into discovery — so a
`render: "js"` adapter could never reach its configured transport during
discovery. (Document retrieval via `documentFetcher` already dispatched on
`render`, but its browser-PDF leg fails on Chromium downloads per the
Step 0 baseline.)

New selection logic (`fetchers/transportSelector.js`, new): `isBrowserAdapter`
reads only `adapter.render`; `fetchPageForAdapter` returns `fetchHTML`
results verbatim for static/unknown adapters and pooled-browser results
(`transport: "browser"`) for js; `fetchDocumentForAdapter` delegates static
documents to `documentFetcher` verbatim, js HTML to the pooled browser, and
js PDFs to the Step 1 browser download capture, normalized to the existing
RawDocument shape. Wired at exactly two seams: the `discoverFromSource`
default (new additive `options.adapter`; explicit `fetchPage` still wins)
and the Step 9 FETCH default (plus adapter passthrough). `crawlSource`,
`documentFetcher`, `httpFetcher`, `browserFetcher`, and `crawleeTransport`
are byte-identical; `CRAWLEE_TRANSPORT` default (`off`) untouched.

Reused Step 1 implementation: `fetchPageViaCrawlee` (`useBrowser`),
`fetchPdfViaBrowserCrawlee` (download capture), `crawlOptsOf`
(timeout/retries incl. adapter overrides). One known delta: the pooled
transport applies configured retries (default 2, adapter-overridable) where
the legacy per-request browser fetcher did none — retries only, semantics
otherwise identical.

## Regression tests (8, all passing)

Static→HTTP verbatim shape + NextStepScraper UA; js→browser (Chromium UA,
`transport: "browser"`); static HTML/PDF shapes unchanged; js PDF bytes
identical via capture; discovery defaults follow the adapter (and explicit
`fetchPage` still wins); controlled failures per-request; no exam names.

## JEE Main live re-test (`jee-main`, `render: "js"`)

- HTTP result: 403 on plain fetch (unchanged sandbox behavior).
- Browser result: landing 200 via pooled browser where HTTP 403s; 119 links
  seen; 3 documents discovered (2× NOTIFICATION, 1× SYLLABUS); first HTML doc
  retrieved 200 / ~124 KB in ~6 s. Selection proven, not assumed.
- PDF/download capture: NOT exercised live — no bulletin link surfaced on
  the landing this run; proven locally with byte-identical capture instead.
- Downstream (full wired Step 9 chain, 60 s): all gates passed
  (SOURCE_VERIFICATION, DOCUMENT_REVIEW, EXTRACTION_REVIEW, DRAFT_REVIEW
  reached); validation ok; draft `DRAFT`, unpublished, 0 production writes.
  Registration nulls (honest — notices pages carry no window); education
  Graduate/MEDIUM flagged investigate (excerpt suggests result-declaration
  boilerplate, not eligibility prose). Operator verdict: PASS_WITH_REVIEW.

## Separated claims

- TRANSPORT VERIFIED: js adapters reach the pooled browser; static path
  byte-identical (UA proof + shapes + full suite).
- SOURCE ACCESS VERIFIED (partial): NTA landing + HTML docs retrievable via
  browser from here; bulletin PDF leg untested live (no link surfaced).
- PIPELINE VERIFIED (seam only): fetch/discovery shapes unchanged,
  downstream untouched, suite green; no new ingestion semantics.

## Remaining limitations → recommended Step 21

Retry delta above; bulletin discovery depends on live link labeling;
browser path needs an accessible network to test fully. Recommended
Step 21 (strictly observed): wire a bulletin-URL fallback probe for js
adapters whose landing stops surfacing the bulletin link, then re-run this
exact protocol — measurement only, no architecture change.
