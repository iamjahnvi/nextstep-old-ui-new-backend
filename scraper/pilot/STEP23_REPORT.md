# STEP 23 Report — Adapter Bulletin Allowlist Freshness

Monitoring only. No adapter rewrites, no replacement discovery, no publishes.
Live runs used real MongoDB (official `mongod 8.2.6`, own dbpath, clean
admin-shutdowns between phases) with an isolated database; zero production
writes. Raw observations: hermetic suite below; live phase outputs inline.

## Freshness design

Per declared URL (≤ `MAX_BULLETIN_URLS` = 5): probe through the existing
render-aware transport → observation (url, finalUrl, redirect flag,
reachability, acceptance, documentType, contentType, byteLength, SHA-256,
reason, timestamp; bytes never stored) → `compareForDrift` against the
stored snapshot in the untouched `surveillanceState` model (one doc per
candidate+URL, baseline + append-only history). Redirects always review
(both URLs preserved, configured URL never rewritten); unreachable-after-
working reviews with the probe error; hash/type changes review via drift
triggers; stable snapshots append `NO_ACTION`. Drift records one Step 8
review item per URL under the shared `surveillance:<candidateId>` key.
`persist: false` compares dry with zero writes. Selection mirrors the
surveillance runner (IDs | limit, cap 5, sequential, isolated).

## Regression (9 hermetic tests, all passing)

Stable→`NO_ACTION` with history growth; changed-bytes→`REVIEW_REQUIRED`
(`content-changed`) + review state; flap→review with reason, cold-down→
`FAILED`; redirect→`redirect-detected`; rotted-PDF→review; bounds (8 URLs →
5 probed, declaration order); adapter deep-equal + fetch-confinement;
dry-run zero writes; unknown-candidate `FAILED`; batch isolation/caps;
size bands; no-publish/no-mutate/no-exam-names scans.

## JEE Main live verification

- Declared CDN bulletin URL → freshness probe → **valid PDF, stable
  observation → `NO_ACTION`**: reachable, accepted, `application/pdf`,
  6,092,568 bytes (identical size to the Step 22 capture), SHA-256
  recorded, ~12 s browser fetch. Transport: pooled browser. No redirect.
- **ALLOWLIST FRESHNESS VERIFIED.**
- Restart cycle on persistent MongoDB (4 separate processes, clean
  shutdowns): baseline → restart → `NO_ACTION` (history 2, hash-stable) →
  labeled simulated change → `REVIEW_REQUIRED` (`content-changed`, review
  persisted) → restart → history 3 (`BASELINE, NO_ACTION, REVIEW_REQUIRED`),
  baseline intact, 1 review state. **Zero entries lost.**
- Duration/errors: ~10–12 s per live browser fetch; no errors; controlled
  stub change completes in ms and is labeled simulated, never presented as
  a production change.

## Remaining limitations → recommended Step 24

CDN rotation is now *detectable* but still operator-resolved (by design);
redirect targets are recorded, never adopted; byte-band context is
informational only. Recommended Step 24 (observed-only): operator workflow
for acting on freshness review states (re-verify → update-or-retire
declaration with provenance), then this exact protocol — no automation.
