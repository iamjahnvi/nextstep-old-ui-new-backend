# STEP 30 Report — Persistent End-to-End Integration Verification

## Verification setup

Step 30 adds a guarded process-boundary verification harness:

- `scraper/tests/step30PersistenceWorker.js`
- `scraper/tests/freshnessDashboardPersistence.test.js`

The harness uses the existing Mongoose models, `checkAllowlistFreshness`, `getFreshnessDashboard`, and the existing declaration/review collections. It does not create a parallel persistence system.

The test requires an operator-supplied `STEP30_MONGO_URI` identifying an isolated Step 30 database. It refuses to claim persistence when that variable is absent and requires the URI to contain `step30` as a basic isolation guard. It does not use `mongodb-memory-server` for the longitudinal persistence claim.

## Exact process sequence

The test launches a separate Node process for each phase:

1. `seed`
   - creates one bounded synthetic test candidate and declaration
   - runs the existing allowlist freshness mechanism with a controlled stub
   - persists `BASELINE`, then stable `NO_ACTION`
   - reads the dashboard
2. `verify-baseline`
   - opens a new MongoDB connection in a new process
   - verifies baseline, two-entry history, absent review state, declaration, dashboard output
   - monitors dashboard commands for writes
3. `change`
   - opens another process
   - uses the existing freshness mechanism with changed controlled bytes
   - verifies `REVIEW_REQUIRED` and `content-changed`
4. `verify-change`
   - opens a new connection in another process
   - verifies baseline, three-entry history, persisted review state, declaration, dashboard output
   - monitors dashboard commands for writes

The process boundaries provide the application restart/reconnect verification. MongoDB restart itself must be performed by the operator using the existing real persistent MongoDB setup between the verification phases when required by the pilot environment.

## Results in this environment

The persistent test was not executed because no explicit `STEP30_MONGO_URI` was configured. The test skips safely rather than using an in-memory database or making an unsupported longitudinal persistence claim.

Run command:

```text
node --test tests/freshnessDashboardPersistence.test.js
```

Actual result in this environment:

- 1 skipped
- 0 failed

When `STEP30_MONGO_URI` points to the isolated persistent MongoDB setup, the same command is expected to produce:

- 1 passed
- 0 failed

## Relevant dashboard tests

The existing focused dashboard tests remain the executable proof for endpoint behavior and zero writes:

```text
node --test --test-concurrency=1 tests/freshnessDashboard.test.js
node --test tests/freshnessDashboardHardening.test.js tests/freshnessDashboardIntegration.test.js ../client/src/pages/freshnessDashboardViewModel.test.js
```

Actual relevant dashboard result in this environment:

- 16 passed
- 0 failed

These tests cover the existing baseline/history/review/declaration/dashboard semantics, input hardening, malformed fields, safe failures, and zero-write dashboard reads.

## Zero-write verification

During both read-only verification phases, MongoDB command monitoring records `insert`, `update`, `delete`, `bulkWrite`, `findAndModify`, `create`, and `createIndexes`. The harness asserts an empty write-command list for dashboard reads.

Freshness setup/change writes are intentionally performed only by the existing operator-controlled surveillance mechanism; dashboard reads themselves remain read-only.

## Defects fixed

No new production defect was discovered or fixed in Step 30. The work is verification-only.

## Remaining limitations

- A real persistent MongoDB URI and operator-controlled restart are required to produce a live persistence pass.
- The harness uses a synthetic isolated candidate and URL; it does not touch production declarations.
- The repository does not contain a persistent MongoDB process manager, so MongoDB process restart remains an environment/pilot operation.
- The full repository suite was not run.

Step 31 was not started.
