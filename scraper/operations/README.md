# Operations — run, watch, recover (STEP 13)

The pipeline (Steps 0–12) decides exam truth; this layer keeps the machine
honest. Nothing here publishes, accepts review items, edits exam data, or
deletes provenance. `auto-publish = false`, `auto-acceptance = false`,
`automatic exam-data updates = false` — by construction (no code path exists),
not by policy alone.

## Run surveillance manually

```text
node scraper/cli/surveillance.js --candidate <id> [--dry-run]
node scraper/cli/surveillance.js --limit 5 [--dry-run] [--persist]
```

Dry-run is the default: checks run, results print, nothing is written. Add
`--persist` (without `--dry-run`) to record state, history, and review
triggers in staging. Outcomes: `NO_ACTION` (unchanged or fresh baseline),
`REVIEW_REQUIRED` (drift — a Step 8 review state is recorded), `FAILED`
(fetch or lookup failure, error preserved, no snapshot invented).

## Start scheduled surveillance

Surveillance has no daemon. Generate deployment-native config that invokes
the existing CLI (see `surveillance/surveillanceScheduler.js`
`buildCronEntry`/`buildSystemdUnits`), e.g. daily 02:00:

```text
0 2 * * * /usr/bin/node /srv/nextstep/scraper/cli/surveillance.js --limit 5 --persist
```

Overlapping ticks refuse safely via the lock file
(`operations/runGuard.js`, default `os.tmpdir()/nextstep-surveillance.lock`,
stale after 1h) and emit a `SCHEDULER_FAILED` notification payload for the
caller to send. Scheduling never publishes anything.

## Stop it

Delete/disable the cron line or systemd timer. In-flight runs finish their
current candidate and release the lock in `finally`; a killed run leaves at
most a stale lock, taken over automatically after staleness expires.

## Inspect failures

```text
node scraper/cli/operations.js status --limit 20
```

Per-candidate `FAILED` entries carry stage + error; operation runs
(`scraper_operation_runs`) carry counts + `errorSummary`. Every event is also
a structured log line (`operations/logger.js`: timestamp, event, runId,
candidateId, stage, status, durationMs, error) with secrets redacted.

## Inspect review-required items

Drift review states live in `scraper_review_states` under keys
`surveillance:<candidateId>` (stage `REVIEW_REQUIRED`, trigger + both
snapshots attached). Nothing is auto-accepted — open them, decide, act
through the existing explicit publish flow only.

## Recover after a failed run

1. `operations.js health` — find the red check (database, config, staging).
2. Fix the dependency (URI, network, disk); re-run `health` until `HEALTHY`.
3. Re-run the failed scope manually (`surveillance.js --candidate …`).
   FAILED candidates re-check cleanly; baselines and history are append-only,
   so no evidence was lost. Stale locks age out on their own.

## Retention, backup, readiness

Retention (`operations/retention.js`) prunes ONLY surveillance/review history
tails (keep 20) and old terminal operation runs (90 days), and only via
`applyRetention({ confirm: true, actor })` — no CLI flag provides this.
Raw documents, drafts, receipts, candidates, and profiles are retained
forever and are never auto-deleted. Back up MongoDB (which holds all staging
+ production) on the deployment's own schedule; verify restores out of band.

```text
node scraper/cli/operations.js health      # exit 1 unless operable
node scraper/cli/operations.js readiness   # exit 1 unless HEALTHY
node scraper/cli/operations.js retention   # read-only prune plan
```

## Publishing stays separate

Publishing remains `scraper/cli/publish.js --draft <id> --dry-run` then an
explicit `--confirm` — single drafts, human-confirmed, idempotent. No
operational command in this directory can publish, accept, or modify exam data.
