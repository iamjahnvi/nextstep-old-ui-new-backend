# Deployment & Observability (STEP 14)

Node.js stays the primary runtime; Python runs only the existing specialist
document service. No cloud, queues, or paid platforms are required — MongoDB,
OS cron/systemd, and the filesystem cover everything below.

## How to deploy

1. Checkout + `npm install` in `scraper/`; `pip install -r requirements.txt`
   in `scraper/python-docproc` (pypdf only; Docling stays dormant).
2. Copy `.env.example` (repo root) to `.env`, set `MONGO_URI` (required).
   Everything else has safe defaults (`CRAWLEE_TRANSPORT=off`, LLM off,
   notifications local-log, dry-run posture).
3. Start the services (see below), then verify:
   `node -e "require('./scraper/operations/verify.js').verifyDeployment().then(r => console.log(JSON.stringify(r, null, 2)))"`
   with `MONGO_URI` set. All steps must pass; nothing is published.

## Environment variables

See `.env.example` for the full list. Secrets (`MONGO_URI`, webhook URLs,
model names) are validated by `operations/config.js` (`loadConfig` throws on
missing/malformed values) and never logged — `getSafeSummary()` prints only
`set`/`unset` markers.

## Start / stop

```text
# Node API/app (existing project entry points, unchanged)
# Python document specialist (only needed for profile-flagged PDFs)
uvicorn app.main:app --host 127.0.0.1 --port 8001   # from scraper/python-docproc
# Stop: Ctrl-C / SIGTERM (uvicorn drains); in-flight scraper runs finish the
# current candidate and release the overlap lock in `finally`.
```

## Install the scheduler

OS cron (`operations/deploy/nextstep-surveillance.cron`, daily 02:00) or
systemd (`nextstep-surveillance.service` + `.timer`): copy the templates,
replace `/srv/nextstep` and the service user, `systemctl daemon-reload` +
`enable --now`. Every tick runs the existing surveillance CLI bounded by
`--limit`; overlaps refuse via `runExclusive()` with a `SCHEDULER_FAILED`
notification payload. Disable the cron line/timer to stop; in-flight runs
finish solo. Scheduling never publishes.

## Logs

Structured JSON lines (timestamp, event, runId, candidateId, stage, status,
durationMs, error) to stdout by default; set `OPS_LOG_DIR` for file output
with single-backup rotation at `OPS_LOG_MAX_BYTES` (default 10 MB). For
system log rotation, add the log dir to `logrotate(8)` (weekly, keep 12,
`copytruncate`) — see this directory's templates folder conventions. Secrets
are redacted recursively; document bodies are never logged (counts/hashes/
URLs only). Metrics (`operations/metrics.js`) are in-process counters plus
read-only staging rollups (runs, review queue, surveillance outcomes,
receipts) — observational only, never decision inputs.

## Health / readiness

```text
node scraper/cli/operations.js health      # exit 1 unless operable
node scraper/cli/operations.js readiness   # exit 1 unless HEALTHY
node scraper/cli/operations.js status      # recent operation runs
node scraper/cli/operations.js retention   # read-only prune plan
```

Checks: database ping, config presence, directories, staging access,
schedule validity, Python `/health` (when configured; absence is healthy),
scheduler lock (held = active run, reported not failed), publish boundary
(dry-run default + confirm gate intact). Health never writes exam data.

## Failed runs

`operations.js status` shows per-run counts + `errorSummary`; per-candidate
entries carry stage + error. Recover: fix the dependency (`health` tells you
which), re-run the failed scope manually (`surveillance.js --candidate …` or
`ingest.js --candidate … --dry-run`). Baselines and history are append-only —
nothing was lost. Stale overlap locks age out automatically (1h default).

## Restore from backup

Nightly `mongodump` of the database holding staging + `exams` (deployment's
own schedule; verify restores out of band), plus `exportSnapshot()` JSON
exports (`OPS_BACKUP_DIR`) verified by `verifyBackup()`. Restore: stop the
scheduler, `mongorestore` to a staging database first, verify counts, then
promote. Retention prunes ONLY history tails (keep 20) and old terminal runs
(90d) behind explicit confirm+actor — raw documents, drafts, receipts,
candidates, and profiles are never auto-deleted.

## Verify deployment

`verifyDeployment()` runs configuration → dependencies → Python →
database → health → scheduler → lock → logging → notification →
publish-boundary, returning `{ passed, steps[] }`. Skips (unconfigured
Python/schedule) never fail. Verification publishes nothing and writes no
exam data (one probe log line to your sink, one probe-lock round-trip).

## What requires manual operator approval

Everything that changes truth: adjudications, draft promotion, `--confirm`
publishes (single drafts, idempotent), retention pruning (`confirm`+actor),
restore promotion. Surveillance, ingestion, scheduling, notifications, health,
backups, and verification are all read-only or staging-only by construction.
