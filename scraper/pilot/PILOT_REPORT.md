# STEP 15 Pilot Report — Live Sources (measurement only)

Bounded pilot: exactly 2 real authority sources, operator-supervised, isolated
staging database, zero production writes, zero publishes. Architecture frozen;
every stage reused production code paths (Steps 9/10/12) against live bytes.
Raw run JSON (with live excerpts): `scraper/pilot/results/` (gitignored).

## Selected sources

| | Source A | Source B |
|---|---|---|
| Exam | GATE 2026 | JEE Advanced 2026 |
| Authority domain | gate2026.iitg.ac.in (HTTP 200, ~45 KB landing) | jeeadv.ac.in (HTTP 200, ~65 KB landing) |
| Adapter | `gate-2026` (static) | `jee-advanced` (static + PDF via `matchUrl: IBEnglish`) |
| Source type/profile | STATIC_HTML, transport HTTP | STATIC_HTML landing; PDF bulletin (118-page brochure) |

JEE Main (`jeemain.nta.nic.in`, HTTP 403 to plain fetch — known, needs
browser) was intentionally NOT piloted: 2-source bound. Browser/PDF behavior
is exercised by Source B's real bulletin download + parse instead.

## Source A — GATE 2026: what happened

Surveillance: baseline established, `NO_ACTION`, no error (~1 s). Ingestion:
`DRAFT_REVIEW` in ~5 s — 10 documents discovered (eligibility, fees,
syllabus hub, schedule, dates, notifications, pattern + 3 syllabus PDFs),
10/10 fetched (HTTP 200, no retries observed), extraction over 36,568 chars,
draft staged, review stage `REVIEW_REQUIRED`.

### What worked

Static fetch, relative-URL resolution, multi-page + PDF discovery and
retrieval, table-date extraction (opening 2025-08-28 = latest-listed
revision, accepted), honest multi-category `UNKNOWN` education with preserved
excerpts, empty-vocab `UNKNOWN` streams/subjects, staging + review states.

### Review findings (operator verdicts after live inspection)

- name / full form / conductingBody / website — **accepted** (landing title
  "GATE 2026", footer "Organizing Institute: IIT GUWAHATI", verified live).
- registration.startDate 2025-08-28 — **accepted** (last-listed opening revision).
- registration.endDate 2025-10-06 — **investigate** (see gaps: BUG-1).
- eligibility.education UNKNOWN — **accepted** (degree-category list has no
  single minimum; guessing would be wrong).
- stream / subjects / percentage / age UNKNOWN — **accepted** (degree-based
  admission; no bars stated on source).

### Publish result

Not published — correctly. Dry-run publish refused by the boundary:
`only VERIFIED drafts are publishable` plus null education/streams/subjects.
Draft remains `DRAFT`/`REVIEW_REQUIRED`. Zero writes beyond staging.

## Source B — JEE Advanced 2026: what happened

Surveillance: baseline established, `NO_ACTION` (~1 s). Ingestion:
`DRAFT_REVIEW` in ~7 s — 2 documents (generic-`Link` → `IBEnglish_2026.pdf`
via URL rule + `eligibility.html`), both fetched, 118-page PDF parsed to
~160K chars through the existing PDF path, draft staged, review
`REVIEW_REQUIRED`.

### What worked

URL-substring discovery on content-free anchors, real-world PDF
download + parse at volume, marks-anchored percentage (75% aggregate,
verified in excerpt), DOB-cutoff → `NEEDS_VERIFICATION` (design behavior),
honest null registration (criteria brochure carries no window), empty-vocab
`UNKNOWN` streams/subjects.

### Review findings

- name / fullForm / conductingBody / website — **accepted** (landing
  "JEE (Advanced) 2026"; brochure names IIT Roorkee as organizer).
- education 12 — **accepted** (criterion A4, Class XII).
- percentage 75 — **accepted** ("at least 75% aggregate", marks-anchored).
- age NEEDS_VERIFICATION — **accepted** (DOB cutoff, not an integer).
- registration nulls — **accepted** as honest (no window in criteria sources).
- streams / subjects UNKNOWN — **accepted**.

### Publish result

Not published — correctly. Dry-run refused: `DRAFT` status, null
streams/subjects/dates. Zero writes beyond staging. Sign-off **withheld**
for both sources (open investigate item + unpublishable UNKNOWNs/nulls).

## Baseline comparison (Step 0 local mirrors vs live)

| Metric | Step 0 | Live pilot | Verdict |
|---|---|---|---|
| GATE fetch success / docs | ok, 2 docs, ~51 ms | ok, 10 docs, ~5 s run | NOT COMPARABLE (rule-scoped fixture vs broad live discovery + network) |
| JEE Adv fetch / PDF | ok, 1 doc, ~13 ms | ok, 2 docs incl. 118-page PDF parsed (~160K chars), ~7 s | NOT COMPARABLE (fixture scale differs) |
| Retry / timeout behavior | 3 attempts; ~527 ms timeout | no failures observed live | NOT COMPARABLE (no faults injected live — correctly) |
| Duplicate-URL fetch count | 2 (no fetch dedup) | no duplicate situations arose | NOT COMPARABLE |
| Browser (JEE Main 403 path) | fails locally as download | not exercised | NOT COMPARABLE |
| PDF round trip | stub fixture unparseable | real bulletin parsed | NEW OBSERVATION: production PDF path succeeds at volume |
| Multi-revision date cells | single-date fixtures | 4-revision concatenated cells picked mid-list (Oct 06 vs Oct 07) | NEW OBSERVATION → BUG-1 |
| Repeated live fetch link sets | n/a | 10 vs 7 docs minutes apart | NEW OBSERVATION → source-variance note |

## Observed gaps

- **BUG-1 (extraction confidence):** GATE endDate Oct 06 selected from a
  4-revision concatenated cell whose latest entry is Oct 07 — while marked
  HIGH/AUTO_ACCEPTABLE. Evidence excerpt contains Oct 07, so review *can*
  catch it, but the queue wouldn't surface it. Fix belongs to a future
  extraction step (last-listed-revision preference in undifferentiated
  cells + confidence downgrade on multi-date cells). Not implemented here.
- **SOURCE-SPECIFIC ISSUE:** live GATE landing yielded different link sets
  across runs minutes apart (rotating notices suspected); loopback baselines
  cannot reproduce this — longitudinal surveillance (Step 12, persistent DB)
  is the right tool, untested live here.
- **EXPECTED MANUAL REVIEW:** GATE multi-category UNKNOWN, Adv DOB flag,
  Adv null registration window, both drafts' empty-vocab axes — all honest
  outputs awaiting per-category adjudication contracts (future step).
- **OPERATIONAL ISSUE:** first pilot run downloaded an ~800 MB MongoDB
  binary (one-time environment cost); JEE Main browser path untested live;
  longitudinal surveillance across days needs a persistent database (pilot
  used throwaway instances, so cross-time drift comparison is proven only
  in Step 12 stub tests).
- No configuration issues found: both adapters matched live structure
  unchanged (notably the `IBEnglish` URL rule).

## Sign-off

Neither source passed publish sign-off (withheld for both, reasons above).
Both drafts correctly remain `DRAFT`/`REVIEW_REQUIRED`. The pilot validates
the chain's honesty on real data: it retrieved, parsed, extracted with
evidence, flagged ambiguity, and refused to publish — exactly the designed
behavior. The system is **not yet recommended for broader batch testing**
until BUG-1 (date-confidence calibration) is addressed and one longitudinal
surveillance cycle runs against a persistent database.
