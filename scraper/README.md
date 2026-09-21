# NextStep Scraper — Operator Publish Runbook

Manual workflow for publishing a VERIFIED scraping draft to the production
Exam collection. Read this whole file before running any publish command.

Pipeline position of this runbook:

```text
RawDocument → Extraction → ExamEdition DRAFT → REVIEW → VERIFIED
    → (this runbook) → VALIDATED PUBLISH PAYLOAD → production Exam
```

> Scope: this CLI only **describes** (dry-run) or **single-record publishes**
> (explicit `--confirm`) one draft at a time. It never scrapes, extracts,
> revalidates drafts, edits demo data, or touches APIs, UI, cron, Redis,
> Kafka, Apify, or LLMs.

---

## 1. Prerequisites

- Node.js available, dependencies installed (`npm install` in `scraper/`).
- Network access to the MongoDB deployment holding **both** the scraper
  staging collections (`scraper_rawdocuments`, `scraper_editiondrafts`,
  `scraper_publish_receipts`) **and** the production `exams` collection.
- A MongoDB connection URI. Resolution order (first wins):
  1. `--mongo-uri <uri>` CLI flag
  2. `SCRAPER_MONGO_URI` environment variable
  3. `MONGO_URI` environment variable (project convention, see
     `server/config/db.js`)
- Run all commands from the **repository root**
  (`nextstep-old-ui-new-backend/`), using the paths below verbatim.

---

## 2. Inspect a draft

Every publish starts from a staging draft `_id` (a MongoDB ObjectId). Find
candidate drafts by status in the `scraper_editiondrafts` collection
(`DRAFT`, `VERIFIED`, or `REJECTED`).

Rules:

- **Only `VERIFIED` drafts can be published.** `DRAFT` and `REJECTED` ids
  are refused with a clear error and no side effects.
- Never invent or edit draft data to make it publishable. If a draft is
  wrong, send it back through review/reject it — do not hand-edit fields.

---

## 3. Dry-run (default — writes nothing)

```text
node scraper/cli/publish.js --draft <draftId>
node scraper/cli/publish.js --draft <draftId> --dry-run
```

Both forms are identical: **dry-run is the default**, and a bare `--draft`
call prints `No mode flag given — defaulting to dry-run.` The output starts
with `DRY RUN — no database write occurred.`

Inspect each of these in the output before proceeding:

| Field | What to check |
|---|---|
| `draftId` | matches the draft you intend to publish |
| `identity` | `examSlug:year:cycle` (e.g. `jee-main:2026:2026`) — the stable, edition-derived idempotency key, never a name match |
| `target` | must be exactly `exams` |
| `action` | `would-create` (fresh) or `already-published` (receipt exists) |
| `validation` | must be `{ "ok": true }` |
| `exam` | the mapped NextStep payload: name, fullForm, dates, education, streams, subjects, percentage, website; unknowns stay `null` (never invented); `careerType`/`examType` are `null`; there is **no** `month` field |
| `provenance` | draft id, slug/year/cycle, source document refs (url + checksum), evidence entries |

---

## 4. Review (before any confirm)

- Confirm every mapped value against its `provenance.evidence` excerpt and
  source document URL — the excerpt is the reason the value is trusted.
- Confirm the `identity` refers to the intended exam edition (a second
  draft for the same edition will **not** overwrite the first — it fails
  loudly, see Troubleshooting).
- Confirm `action: would-create`. If it says `already-published`, the work
  is already done — stop.
- Confirm unknowns are acceptable: a draft with `null` dates/education is
  rejected by validation, not silently filled. Never fabricate a value to
  force a publish.

---

## 5. Confirmed publish (the only writing step)

```text
node scraper/cli/publish.js --draft <draftId> --confirm [--by <operator-name>]
```

- `--confirm` is the **only** flag combination that writes production data.
  Without it the CLI cannot write, by construction.
- `--by` is optional and records the operator name on the publish receipt.
- Success prints `PUBLISHED — one production Exam record created.` plus the
  `production exam _id`, followed by the full result JSON (the receipt).
- Exactly one `exams` document is created. Nothing else is modified: no
  deletes, no reseeds, no updates to unrelated or demo records — not even on
  name match.

---

## 6. Verify the receipt

- The printed result JSON **is** the receipt: keep it with the release
  notes (`draftId`, `identity`, `examId`, `action`, payload, provenance).
- Re-running the same command is safe (idempotent): the second run prints
  `ALREADY PUBLISHED — no duplicate created, no write performed.` and
  returns the same `examId` with `wrote: false`.
- A staging receipt row (`scraper_publish_receipts`, unique on `identity`)
  records `identity → examId + draftId + publishedAt (+ publishedBy)`.

---

## 7. Safety rules

1. **Dry-run first, every time.** No exceptions.
2. **Never paste credentials** into commands, chat logs, or this file —
   pass the URI via environment (`SCRAPER_MONGO_URI`/`MONGO_URI`) or a
   `--mongo-uri` value that is never stored in history/docs.
3. Production publish requires explicit `--confirm`. There is no
   `--yes-to-all`, no batch mode, no "publish everything VERIFIED".
4. No automatic or scheduled publishing. No cron, no API endpoint, no UI
   trigger in this phase.
5. No scraping/extraction/review changes from this workflow. No changes to
   APIs, frontend, Redis, Kafka, Apify, LLMs, adapters, `month`,
   `careerType`, or `examType` classification.

---

## 8. Troubleshooting

| Symptom (stderr / output) | Meaning | Action |
|---|---|---|
| `--draft <draftId> is required` (exit 1) | id missing | Re-run with `--draft <id>` |
| `pass either --dry-run or --confirm, not both` (exit 1) | conflicting flags | Choose one mode |
| `no MongoDB URI …` (exit 1) | no connection configured | Provide `--mongo-uri` or set `SCRAPER_MONGO_URI`/`MONGO_URI` |
| `draft not found` (exit 1) | wrong id / wrong database | Check the id and that the URI points at the staging database |
| `only DRAFT records can be promoted…` / status is `DRAFT` (exit 1) | draft not yet verified | Send it through review; publish only after `VERIFIED` |
| status is `REJECTED` (exit 1) | rejected drafts never publish | Leave it; extract/review a new draft if needed |
| `payload rejected — …` with `exam` issues (exit 1) | VERIFIED but unpublishable (e.g. null dates/education, bad values, `month` key) | Do not invent data — fix at extraction/review, re-verify, new draft |
| `identity conflict — … already published by a different draft` (exit 1) | another draft owns this edition identity | Never overwrite: investigate which draft is correct; no automatic merge exists |
| `receipt … points at a missing Exam record` (exit 1) | out-of-band delete | Stop and escalate — the CLI will not guess |
| connection timeout / `MongoDB URI` network errors (exit 1) | DB unreachable | Verify URI, network, credentials (via env, never in docs); retry dry-run |

---

## 9. Adjudicating UNKNOWN-with-evidence axes (`--adjudicate`)

When extraction preserves ambiguous evidence (e.g. several possible
education levels), the draft keeps the value `UNKNOWN` instead of guessing.
An operator may then explicitly resolve **one** axis on a staging `DRAFT`.
Adjudication does **not** publish anything and does **not** change
`DRAFT → VERIFIED` — promotion remains a separate, later step.

### Prerequisites

Same as §1: run from the repository root with a MongoDB URI resolved as
`--mongo-uri` > `SCRAPER_MONGO_URI` > `MONGO_URI`. Only `DRAFT` drafts can
be adjudicated; `VERIFIED` and `REJECTED` drafts are immutable and refused
with an error.

### CONFIRM_VALUE example

```text
node scraper/cli/publish.js --adjudicate <draftId> --axis education --decision CONFIRM_VALUE --value "<canonical level>" --by "<operator>"
```

- The operator explicitly selects a canonical education level; canonical
  validation lives inside `adjudicateDraft()` and rejects anything else.
- The original extraction evidence stays attached, byte-identical.
- An adjudication audit record (`axis`, `decision`, `value`, `decidedBy`,
  `decidedAt`, optional `note`) is appended to the draft.

### KEEP_UNKNOWN example

```text
node scraper/cli/publish.js --adjudicate <draftId> --axis education --decision KEEP_UNKNOWN --by "<operator>" --note "<reason>"
```

- The extracted value remains `UNKNOWN` (`null`); `--value` is forbidden
  with this decision and refused if supplied.
- Original evidence remains preserved.
- The decision is still recorded in the audit trail (with `value: null`).

### Verification (CLI output)

A successful run prints `ADJUDICATED — draft status unchanged; no
production publish occurred.` followed by: draft ID, axis, decision,
resulting value and axis status, operator (`decidedBy`), timestamp
(`decidedAt`), the note if supplied, and the audit record as JSON.
Confirm the draft status line still reads `DRAFT`.

### Safety rules

- Adjudication is staging-only and never loads or uses the production
  Exam model.
- Only `DRAFT` drafts can be adjudicated; nothing auto-transitions to
  `VERIFIED`.
- The CLI duplicates no canonical education validation and no business
  rules — all semantics live in `reviewPipeline.adjudicateDraft()`.
- No automatic or batch adjudication exists; each decision names an
  operator via `--by` (required).

### Recommended workflow

```text
extract
→ DRAFT with UNKNOWN + evidence
→ inspect evidence
→ --adjudicate (CONFIRM_VALUE or KEEP_UNKNOWN)
→ review
→ VERIFIED
→ publish dry-run
→ confirmed publish
```

Adjudication itself neither verifies nor publishes a draft.

---

## 10. Inspecting adjudication history (`--adjudications`)

`--adjudications <draftId>` displays every audit record stored on a draft,
oldest first. It is strictly read-only: it performs a single draft lookup
and never modifies, adjudicates, verifies, or publishes anything.

### Prerequisites

Same as §1: run from the repository root with a MongoDB URI resolved as
`--mongo-uri` > `SCRAPER_MONGO_URI` > `MONGO_URI`. Any draft can be
inspected regardless of status. This mode never loads the production Exam
model and cannot be combined with any other CLI mode.

### Command syntax

```text
node scraper/cli/publish.js --adjudications <draftId>
```

### What is displayed

For each stored record, in chronological (`decidedAt`) order:

- `axis` — the eligibility axis the decision concerns
- `decision` — `CONFIRM_VALUE` or `KEEP_UNKNOWN`
- `value` — the confirmed value, or `null` when absent (always `null`
  for `KEEP_UNKNOWN`)
- `decidedBy` — the operator named at decision time
- `decidedAt` — ISO timestamp of the decision
- `note` — printed only when the record carries one

The run ends with the full record list as JSON (`{ "adjudications": [...] }`).
No evidence excerpts or source payloads are printed — records contain only
the decision audit.

### Example — draft with no adjudications

```text
node scraper/cli/publish.js --adjudications 64f1a2b3c4d5e6f708192a3b

draft: 64f1a2b3c4d5e6f708192a3b  status: DRAFT
No adjudications recorded for this draft.
```

### Example — draft with multiple adjudications

```text
node scraper/cli/publish.js --adjudications 64f1a2b3c4d5e6f708192a3b

draft: 64f1a2b3c4d5e6f708192a3b  status: DRAFT
axis: education  decision: CONFIRM_VALUE  value: Graduate
decidedBy: operator-1  decidedAt: 2026-09-20T08:14:20.141Z
note: UG track confirmed
axis: percentage  decision: KEEP_UNKNOWN  value: null
decidedBy: operator-2  decidedAt: 2026-09-20T08:15:02.009Z
{ "adjudications": [ ... ] }
```

### Verification use

Before continuing the normal workflow (review → `VERIFIED` → publish
dry-run → confirmed publish), use this output to confirm *who decided
what*: every `UNKNOWN` the draft still carries should either have a
matching `KEEP_UNKNOWN` record or be a field nobody has reviewed yet, and
every `KNOWN` value that came from adjudication (rather than extraction)
should have a matching `CONFIRM_VALUE` record with its rationale in `note`.

### Safety rules

- Read-only: the draft is byte-identical before and after inspection.
- This command does not adjudicate anything, does not verify the draft,
  and does not publish anything.
- Invalid or unknown draft IDs fail with a clear error and exit code `1`;
  success exits `0`.

---

## Reference

- CLI: `scraper/cli/publish.js` (`--help` prints usage; exit `0` success, `1` any failure)
- Adjudication: `reviewPipeline.adjudicateDraft()` (service) + `--adjudicate` CLI mode (thin wiring only)
- Executor: `scraper/publish/publishExecutor.js` (dry-run default, `confirmPublish` gate, idempotent receipts)
- Mapping/validation: `scraper/publish/examMapper.js`, `scraper/publish/publishValidator.js`, `scraper/publish/publishService.js`
- Staging models: `scraper/models/examEditionDraft.js`, `scraper/models/publishReceipt.js`
- Tests: `npm test` in `scraper/` (isolated databases only; production is never connected by tests)
