# STEP 27 Report — Freshness Dashboard Integration & Hardening

## Files changed

Created:

- `scraper/tests/freshnessDashboardIntegration.test.js`
- `scraper/pilot/STEP27_REPORT.md`

Modified:

- `client/src/pages/freshnessDashboardViewModel.js`
- `client/src/pages/FreshnessDashboard.jsx`
- `client/src/pages/freshnessDashboardViewModel.test.js`

No new data model, endpoint, scraper operation, persistence path, or dashboard source was added.

## Integration path verified

The dashboard request path remains:

```text
FreshnessDashboard
  -> client api.get("scraper/freshness", { params })
  -> /api/v1/scraper/freshness
  -> freshnessDashboardController
  -> getFreshnessDashboardData
  -> getFreshnessDashboard
  -> existing staging collections/models
```

The UI does not read MongoDB directly and does not calculate freshness outcomes. The Step 25 service remains the single source of truth for:

- freshness status
- baseline observations
- latest observations/history
- review state
- declaration active/retired state

The Step 27 client boundary only validates shapes and preserves values supplied by the endpoint.

## Hardening changes

- Missing or malformed result objects now render safely.
- Missing candidate IDs remain `null`; no synthetic domain identity is invented.
- Missing bulletin URLs render as “Bulletin URL not recorded” and are not turned into links.
- Missing observations remain absent and render as “Not recorded”.
- Invalid optional reasons are discarded rather than displayed as fabricated values.
- Missing declaration status defaults only to the UI-safe `unknown` display state.
- No mutation controls or mutation API calls were added.

## Targeted tests run

```text
node --test scraper/tests/freshnessDashboardIntegration.test.js client/src/pages/freshnessDashboardViewModel.test.js
```

Result:

- 10 passed
- 0 failed

Coverage includes:

- empty dataset response
- `NO_ACTION`
- `REVIEW_REQUIRED`
- `FAILED`
- retired declaration
- candidate/status/limit filters
- bounded result handling
- baseline observation
- latest observation/history
- linked review data
- malformed/missing optional fields
- use of the existing Step 25 GET endpoint
- absence of mutation controls and scraper execution imports

The existing Step 25 endpoint suite was also run:

```text
node --test --test-concurrency=1 scraper/tests/freshnessDashboard.test.js
```

Result:

- 15 passed
- 0 failed

This includes the complete endpoint request-path zero-write assertion.

Client validation:

```text
npm run build
npm run lint
```

Results:

- Production client build passed.
- ESLint passed.

## Zero-write verification

The Step 25 endpoint test captured MongoDB command events during dashboard reads and observed zero insert, update, delete, bulk-write, or find-and-modify commands.

The Step 27 UI and integration checks additionally verify that the page contains only the existing GET request and no POST, PUT, PATCH, DELETE, UPDATE, RETIRE, PUBLISH, or RESOLVE controls.

## Execution paths explicitly not triggered

Dashboard loading does not invoke:

- surveillance execution
- freshness probing
- declaration resolution
- publishing
- extraction
- automatic updates
- scheduling
- queues
- automation

## Remaining limitations

- The repository has no browser component-test runner; UI rendering is validated through the pure response-boundary tests, source-level integration checks, Vite build, and ESLint.
- The dashboard continues to rely on Step 25 adapter resolution and status semantics.
- The full repository test suite was intentionally not run.

