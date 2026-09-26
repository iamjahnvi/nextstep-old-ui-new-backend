# STEP 29 Report — Production Hardening of the Freshness Dashboard

## Files changed

Created:

- `scraper/tests/freshnessDashboardHardening.test.js`
- `scraper/pilot/STEP29_REPORT.md`

Modified:

- `scraper/surveillance/freshnessDashboard.js`
- `scraper/tests/freshnessDashboard.test.js`

No new endpoint, model, data source, freshness implementation, UI control, or persistence path was added.

## Validation behavior

- Candidate IDs must be non-empty strings after trimming.
- Status filters must be one of `NO_ACTION`, `REVIEW_REQUIRED`, or `FAILED`.
- Limits must be positive integers.
- Limits above the existing `DEFAULT_MAX_CANDIDATES` cap are rejected with a deterministic `DashboardRequestError`; they are no longer silently clamped.
- Candidate reads remain bounded and deterministic:
  - candidate ordering is `discoveredAt ASC, candidateId ASC`
  - status-filtered reads never exceed the existing cap
  - requested result limits are applied after status matching
- Missing records return the existing empty result shape.
- Controller read/database failures return HTTP 500 with the existing generic message and do not expose internal details in the response or log message.
- Malformed optional dashboard fields continue to be normalized safely by the Step 27 client boundary without inventing values.

## Tests and exact results

Targeted Step 29 and related dashboard tests:

```text
node --test scraper/tests/freshnessDashboardHardening.test.js scraper/tests/freshnessDashboardIntegration.test.js client/src/pages/freshnessDashboardViewModel.test.js
```

Expected coverage:

- valid filters
- invalid candidate ID
- invalid status
- invalid and oversized limits
- safe database/read failure response
- bounded and deterministic dashboard behavior
- malformed optional fields
- read-only endpoint/control checks

Existing Step 25 dashboard suite:

```text
node --test --test-concurrency=1 scraper/tests/freshnessDashboard.test.js
```

This remains the authoritative endpoint behavior and zero-write suite.

Client validation when UI files are involved:

```text
npm run build
npm run lint
```

The full repository suite was intentionally not run.

## Zero-write verification

The Step 25 focused suite monitors MongoDB commands during the complete dashboard request path and asserts no insert, update, delete, bulk-write, find-and-modify, collection-creation, or index-creation commands occur during read operations.

Step 29 added no write-capable code or controls and does not invoke surveillance, probing, declaration resolution, UPDATE/RETIRE, publishing, extraction, scheduling, queues, or automatic updates.

## Remaining limitations

- The strict maximum is the existing operations-layer `DEFAULT_MAX_CANDIDATES` value of 5; increasing it remains an explicit future policy decision.
- Counts and UI summaries remain bounded to the returned endpoint dataset.
- Browser-level component tests are not available in the repository.
- The full repository test suite was not run by design.
