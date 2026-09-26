# STEP 25 Report — Read-Only Freshness Dashboard Data Endpoint

## Implementation summary

Step 25 added the read-only freshness dashboard data service and protected
`GET /api/v1/scraper/freshness` endpoint. It reuses the existing staging
collections for candidates, surveillance state, review state, and allowlist
declarations. It does not create a second freshness store or execute
surveillance, probing, resolution, extraction, publishing, or scheduling.

The service returns bounded candidate/exam identity, effective and retired
bulletin URLs, declaration state, baseline and latest observations, freshness
status, drift/review reasons, linked review state, timestamps, and history
metadata.

## Files created or modified

- `scraper/surveillance/freshnessDashboard.js`
- `server/controllers/freshnessDashboardController.js`
- `server/routes/freshnessDashboardRoutes.js`
- `server/routes/index.js`
- `scraper/models/examCandidate.js`
- `scraper/models/surveillanceState.js`
- `scraper/models/reviewState.js`
- `scraper/models/allowlistDeclaration.js`
- `scraper/tests/freshnessDashboard.test.js`
- `scraper/package.json`

The model factories support a read-only mode that disables auto-index and
auto-create side effects for dashboard reads.

## Endpoint behavior

`GET /api/v1/scraper/freshness` supports:

- candidate ID filtering
- `NO_ACTION`, `REVIEW_REQUIRED`, and `FAILED` status filtering
- positive bounded limits up to `DEFAULT_MAX_CANDIDATES` (5)
- deterministic candidate and bulletin ordering
- status filtering before applying the requested result limit
- generic HTTP 500 handling for read/database failures

Invalid filters return HTTP 400. Missing records produce an empty result.

## Tests

The focused Step 25 suite covered empty results, stable `NO_ACTION`,
`REVIEW_REQUIRED`, `FAILED`, retired declarations, linked review state,
baseline/latest observations, bounded limits, candidate/status filters,
deterministic output, and zero database writes.

The final focused run for this report is recorded in the later Step 32 audit;
the Step 25 regression suite contains 15 passing tests and 0 failures.

## Read-only proof

Dashboard model reads use the existing staging collections with read-only
model factories. The Step 25 test suite monitors MongoDB command events during
dashboard requests and asserts no insert, update, delete, bulk-write,
find-and-modify, collection-creation, or index-creation commands occur.

No publishing, automatic acceptance, automatic exam-data updates, scheduling,
queues, or automation were added.

## Persistence limitation

Step 25's focused tests use the repository's isolated test database helper.
Longitudinal persistent MongoDB verification is an operator/pilot concern and
was not claimed by this report. Steps 30 and 31 document the guarded
process-boundary harness and the unavailable persistent MongoDB prerequisite.

