# STEP 26 Report — Read-Only Freshness Dashboard UI

## Implementation summary

Step 26 adds a minimal protected React view at `/freshness`. It consumes the existing Step 25 endpoint at `GET /api/v1/scraper/freshness` and does not read MongoDB directly or introduce another freshness data model.

The view displays candidate identity, effective bulletin URLs, active/retired declaration status, aggregate freshness status, latest and baseline observations, timestamps, drift/review reasons, linked review state, and history counts/latest history timestamps. Candidate ID, freshness status, and bounded limit are passed through to the Step 25 endpoint.

The page is explicitly read-only. It performs only the existing GET request and renders returned data. It has no surveillance, probing, resolution, publishing, scheduling, queue, or automation controls.

## Files created

- `client/src/pages/FreshnessDashboard.jsx`
- `client/src/pages/FreshnessDashboard.css`
- `client/src/pages/freshnessDashboardViewModel.js`
- `client/src/pages/freshnessDashboardViewModel.test.js`
- `scraper/pilot/STEP26_REPORT.md`

## Files modified

- `client/src/App.jsx` — registered the protected `/freshness` route.

No scraper models, review logic, extraction logic, or transport were modified. The Step 25 read-model was updated only to ensure status-filtered results fill the requested bounded limit before this UI consumes them.

## Data source and behavior

The page calls `api.get("scraper/freshness", { params })`, reusing the Step 25 read-only endpoint and its existing bounded filters:

- `candidateId`
- `status`
- `limit`

The UI normalizes malformed or empty endpoint responses into an empty state and reports request failures inline. Bulletin URLs are rendered as ordinary external links; no mutation actions are presented.

## Targeted tests and results

Command:

```text
node --test client/src/pages/freshnessDashboardViewModel.test.js
```

Expected targeted coverage:

- empty endpoint response
- candidate/status/limit filter preservation
- deterministic observation and timestamp formatting

The client build and lint commands are also the relevant validation for the React surface:

```text
npm run build
npm run lint
```

## Zero-write verification

The UI issues only an HTTP GET request to the existing Step 25 endpoint. It contains no POST, PUT, PATCH, or DELETE calls and no database access. No database writes are possible from the new client code.

Step 25's existing focused test suite remains the source of proof for the endpoint's zero-database-write behavior.

## Limitations

- The page is intentionally a minimal operator view, not a generic dashboard framework.
- It does not provide review, declaration, remediation, publishing, or scheduling actions.
- It relies on the Step 25 endpoint's existing candidate-to-adapter resolution and status semantics.
- The repository has no browser component-test runner, so targeted client behavior is covered through the pure view-model tests plus the Vite build/lint checks.

## Explicit scope confirmation

No automation, workflow, scheduling, queue, surveillance execution, freshness probing, declaration update, UPDATE/RETIRE action, publishing, or automatic exam-data update was added.
