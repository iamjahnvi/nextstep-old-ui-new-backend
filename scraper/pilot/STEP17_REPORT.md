# STEP 17 Report — Pilot Re-validation & Controlled Expansion

Validation gate, not architecture: pipeline, extraction, review, publish, and
operations code are byte-identical to Steps 0–15 (only `pilot/reporting.js`
gained a pure verdict helper). Live runs used isolated staging databases;
zero production writes, zero publishes. Raw run JSON: `pilot/results/`
(gitignored).

## 0. Step 16 verification — NOT APPLICABLE

Step 16 (date-confidence calibration + persistent longitudinal surveillance)
was never implemented in this tree: no calibration code exists, no persistent
store exists. There was nothing to verify, so Step 17 validated the two
preconditions directly instead — and both failed. Everything below follows
from that fact; no Step 16 work was performed or smuggled in here.

## 1. BUG-1 status — CONFIRMED PRESENT (blocks expansion)

Re-ran both live pilots 2026-09-25 (fresh isolated DBs, real bytes):

- GATE regular-closing cell on the live page is unchanged: four successive
  revisions concatenated (`Sep 25 → Sep 28 → Oct 06 → Oct 07, 2025`).
- The extractor again selected **Oct 06** graded **HIGH / AUTO_ACCEPTABLE**;
  the latest-listed valid revision is **Oct 07**. An isolated probe of the
  exact cell selects Sep 25 HIGH — also wrong. Both modes miss Oct 07.
- Regression test added as `todo` (`tests/pilotRevalidation.test.js` §2: last-
  listed revision wins + confidence downgrade on multi-date cells). It fails
  against current code and is absorbed as todo — removing the marker is the
  Step 16 fix's acceptance proof. Validation was NOT weakened to pass.

## 2. Persistent surveillance — LOGIC VALID, DURABILITY ENVIRONMENT-LIMITED

- Surveillance logic across runs is sound: baseline → NO_ACTION on identical
  bytes (hash-stable) → REVIEW_REQUIRED (`content-changed`) on altered bytes,
  with review state + append-only history in-session (Step 12 suite green).
- Cross-restart durability with mongodb-memory-server on this Windows host is
  **unreliable for racing writes**: isolated probes show created documents
  survive restarts while array-push saves are sometimes lost
  (`push-probe`: setup kept, pushed entry gone; `persist-probe`: in-process
  cycles fully consistent; no leaked mongod processes; 31 data files present).
  Mechanism: WiredTiger checkpoint/journal recovery race on unclean Windows
  shutdowns — environmental, not application code (in-session reads are always
  consistent; the code path is identical). Consequence: a genuine
  longitudinal cycle needs a real MongoDB deployment; it cannot be proven
  with memory-server restarts here.

## 3. Original pilot re-validation

| Exam | Run | Operator verdict |
|---|---|---|
| GATE 2026 | DRAFT_REVIEW, 10 docs, dates as above, education honestly UNKNOWN | **FAIL** (BUG-1: incorrect authoritative date classification stands) |
| JEE Advanced 2026 | DRAFT_REVIEW, bulletin parsed (~160K chars), education 12, 75%, DOB flag, null dates — identical to Step 15, no overconfident claims | **PASS_WITH_REVIEW** |

Field verdicts match Step 15 throughout (start Aug 28 accepted; endDate
investigate; Adv 12/75%/DOB-flag/unknowns accepted as honest).

## 4. Publishing boundary verification

Fresh live GATE draft re-ingested and dry-run through the existing boundary:
refused (`only VERIFIED drafts…` + null education/streams/subjects), zero
writes. Duplicate protection and confirm mechanics remain covered by Step 10
isolated tests (re-run in the suite below). No draft was promoted or
published; sign-off withheld for both exams.

## 5. Controlled expansion — NOT ATTEMPTED (entry gates unmet)

BUG-1 open + cross-restart durability unproven ⇒ safety gates forbid
expansion. Zero additional sources touched. Decision: **EXPANSION BLOCKED**.

## 6. Quality observations (no fixes applied)

- Extraction: BUG-1 only new item; all other live behavior matches Step 15.
- Confidence: HIGH/AUTO_ACCEPTABLE on the contested date is the sharp edge.
- Dates: 4-revision concatenated cells are the adversarial shape.
- Source-specific: none new (adapters matched live structure unchanged).
- Operational: one-time ~800 MB MongoDB binary download; browser path
  (JEE Main) still untested live.

## Decision

**EXPANSION BLOCKED** — factual status: the architecture behaves as designed
everywhere except the known date-confidence defect, which this step proved
is still live, and persistence validation is host-limited. Broader batch
ingestion is not justified by the observed evidence.
