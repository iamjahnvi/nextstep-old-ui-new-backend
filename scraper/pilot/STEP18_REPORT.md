# STEP 18 Report — Step 16 Remediation + Re-gate

Remediation + validation only. Pipeline, review, publish, and operations
architectures untouched; the single behavior change is confined to
`extractors/registrationDates.js` (revision-cluster rule) plus tests.
Live runs used isolated staging; zero production writes, zero publishes.
Raw run JSON: `pilot/results/` (gitignored).

## BUG-1 — root cause and fix

Root cause: `firstDateAfter()` / `linkedReplacements()` captured the FIRST
date after a label, so in a concatenated multi-revision cell
(Sep 25 → Sep 28 → Oct 06 → Oct 07) the pick was positional-but-stale
(Oct 06 via the extended-row statement) graded HIGH — an authoritative
classification of a superseded date.

Fix (generalized, no GATE/exam specifics): a **revision cluster** — 2+
dates glued after one label with only whitespace/punctuation/weekday names
between, inside a compact span — resolves to the LAST valid date at MEDIUM.
Sentence breaks, other words, or a BACKWARD time step end the run (a glued
earlier date belongs to another event, e.g. a notice date; explicit
preponement still works via revision verbs). Single-date statements keep
HIGH; slots keep their strongest sighting, so HIGH evidence elsewhere is
never downgraded by a cluster. The mid-list-at-HIGH failure mode cannot
recur by construction.

## Regression tests

`tests/pilotRevalidation.test.js`: the Step 17 `todo` is now a normal
passing test (isolated 4-revision cell → Oct 07, confidence ≠ HIGH), plus
edge cases — single dates stay HIGH, explicit revised statements still win
at HIGH, bare-extension clusters resolve last, glued-earlier-date ends the
run (live notifications-page shape → Aug 28 HIGH). The edge case caught a
real overreach of the first fix iteration (backward-step guard added).

## GATE live verification (Part E)

Re-ran the live GATE source post-fix: startDate **Aug 28 MEDIUM**,
endDate **Oct 13 MEDIUM** (extended-row last revision), both
REVIEW_REQUIRED with full evidence. Oct 06/HIGH is gone. Recorded:
selected date, MEDIUM confidence, review-required state, evidence with all
three schedule rows, provenance intact. Operator verdict on endDate:
investigate (regular-vs-extended product semantics need a decision), not
accepted — correctly surfaced, not silently resolved.

## MongoDB persistence

Setup: official `mongod 8.2.6` binary (npm cache, no new technology),
`--dbpath <tmp>/realdb --port 27027 --bind_ip 127.0.0.1`, clean
`adminCommand({shutdown:1})` between phases, one phase per OS process.
Cycle on the REAL GATE landing bytes: baseline established → full stop →
restart → unchanged re-check `NO_ACTION`, history 2, hash-stable →
labeled simulated change → `REVIEW_REQUIRED` (`content-changed`) + review
state → restart → history 3 (`BASELINE, NO_ACTION, REVIEW_REQUIRED`),
baseline intact, 1 review. Zero entries lost across three restarts. This
also diagnoses Step 17: the lossy behavior was `mongodb-memory-server`
lifecycle on Windows, not application code.

## Step 17 re-gate

- GATE 2026: DRAFT_REVIEW, all prior observations hold, BUG-1 failure mode
  eliminated, residual endDate under flagged review → **PASS_WITH_REVIEW**.
- JEE Advanced 2026: unchanged honest output (12, 75%, DOB flag, null
  dates) → **PASS_WITH_REVIEW**.
- Surveillance baselines re-established, NO_ACTION on re-check.
- Publishing boundary re-verified: fresh live GATE draft dry-run refused
  (`DRAFT` status + unpublishable fields), zero writes. No promotions, no
  publishes; duplicate protection remains Step 10-suite covered.

## Safety checks

No auto-publish / auto-acceptance / exam-data-update paths added or
touched; `publish/` byte-identical; review/confidence rules untouched;
validation strictness unchanged (all 367 pre-existing green lights still
green); no Redis/Kafka/cloud/LLM/Crawlee changes; no batch expansion run.

## Tests

- Node: full suite green including the un-todoed regression (counts below).
- Python: unchanged service, re-run green.
- Real-MongoDB cycle: 4/4 phases pass with clean shutdowns.
- Live re-gate: 2/2 sources at DRAFT_REVIEW with intended classifications.

## Final gate status

**RE-GATE PASSED** — with restrictions: expansion bounded to 3–5 exams,
multi-activity schedule dates stay review-required by construction (MEDIUM
downgrade is now automatic), longitudinal claims require persistent
MongoDB, JEE Main browser path still untested live.
