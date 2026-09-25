# STEP 19 Report — Restricted Expansion Pilot (3 exams)

Measurement only, on persistent real MongoDB (official `mongod 8.2.6`,
own dbpath, clean admin-shutdowns between phases — the Step 18 pattern).
Isolated database; zero production writes, zero publishes. Raw run JSON:
`pilot/results/` (gitignored). Architecture frozen (only additive
`summarizeExpansion` helper + this report + tests).

## Sources

| | GATE 2026 | JEE Advanced 2026 | JEE Main |
|---|---|---|---|
| Authority | gate2026.iitg.ac.in (200) | jeeadv.ac.in (200) | jeemain.nta.nic.in (403 all transports) |
| Adapter | `gate-2026`, static | `jee-advanced`, static + PDF | `jee-main`, browser (`render: js`) |
| Profile | STATIC_HTML / HTTP | STATIC_HTML landing; PDF bulletin | unreachable from here |

## Ingestion

- GATE: surveillance baselined then `NO_ACTION` across restarts; 10 docs
  (7 HTML + 3 syllabus PDFs), 10/10 fetched, extraction → DRAFT,
  review REQUIRED. Gates all passed/reached.
- JEE Adv: same shape; 2 docs (bulletin PDF + eligibility page), bulletin
  parsed (~160K chars), DRAFT, review REQUIRED.
- JEE Main: surveillance FAILED (403); ingestion verified the adapter trust,
  then stopped cleanly at DOCUMENT_REVIEW (HTTP-only discovery fetched
  nothing). No draft, no writes beyond staging, no unhandled failure.
  A direct browser landing probe also 403s — NTA blocks this environment
  on every transport, including headless Chromium.

## Date-quality audit (MEDIUM queue as primary instrument)

- GATE start Aug 28 MEDIUM — revised opening, verified against the live
  table → accepted. End Oct 13 MEDIUM (extended-row last revision) —
  investigate (regular-vs-extended product semantics), flagged not silenced.
- Oct 06/HIGH is gone on every run since the Step 18 fix; no incorrect
  HIGH anywhere in the expansion. Backward-step guard untriggered live
  (covered by unit edge test).
- Adv dates remain honestly null (no window in criteria sources).

## Surveillance

Baselines established per candidate; re-checks `NO_ACTION` with hash
stability; history grows append-only across real restarts (3/3 candidates
at length 3: BASELINE, NO_ACTION, NO_ACTION); JEE Main FAILED entries
preserved with errors. Persistent history: proven, zero losses.

## Operator results

- GATE 2026: **PASS_WITH_REVIEW** (open date-semantics item, honest UNKNOWNs).
- JEE Advanced 2026: **PASS_WITH_REVIEW** (unchanged honest profile).
- JEE Main: **FAIL** (source unreachable from this environment on every
  transport; safe gate stops only — bounded, expected, documented since
  Step 0).

## Publishing

Both staged drafts dry-run refused (DRAFT status + unpublishable UNKNOWNs/
nulls), zero writes. Receipt collection empty. Duplicate protection remains
Step 10-suite covered. No promotions, no publishes, no confirmations issued.

## Issues

- **SOURCE-SPECIFIC:** JEE Main unreachable (bot defenses vs sandbox
  network, all transports) + HTTP-only discovery never invokes the browser
  path (known design gap: transport selection unwired; default chain stops
  safely at DOCUMENT_REVIEW).
- **EXPECTED REVIEW:** GATE product-semantics item (regular vs extended),
  both drafts' UNKNOWN axes, Adv DOB flag.
- **OPERATIONAL:** persistent MongoDB required for continuity claims
  (memory-server proven lossy on Windows); browser path needs an
  accessible network to test at all.
- No BUG, CONFIGURATION, or safety-gate findings. No stop condition tripped:
  no unjustified HIGH, no BUG-1 return, provenance complete, history
  intact, publish boundary never bypassed, writes staging-only.

## Final gate

```text
RESTRICTED EXPANSION PASSED WITH RESTRICTIONS
```

Restrictions: static/HTML+PDF shapes only — browser-rendered sources
excluded from the default chain until transport selection is wired and
re-tested from an accessible network; MEDIUM dates stay review-required
/automatic; longitudinal claims require persistent MongoDB. Broader batch
testing is justified ONLY within these restrictions, operator-supervised,
dry-run-first — never as an automatic expansion.
