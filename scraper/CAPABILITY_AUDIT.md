# Scraper Capability Audit — Generic Exam-Ingestion Readiness

Re-audit after Phases 18–22 (audit-only update; no code changed for this
assessment). Method: re-read the implementation, re-ran the searches behind
every classification, re-ran the full suite. Evidence: two live adapters
(`registry/exams/jee-main.js`, `registry/exams/gate-2026.js`) run through
identical pipelines, plus the 136-test isolated suite (all green).

Verdict: **a new exam shaped like JEE/GATE can now be added primarily
through registry configuration + source verification — no generic engine
blockers remain for that path. Broad *batch* onboarding is still NOT
appropriate**: orchestration, scheduling, and extraction-recall boundaries
below are still manual, single-exam affairs.

Classes: READY (generic, reusable) · PARTIAL (works, clear generic limit) ·
MISSING (needed before broad onboarding) · EXAM-SPECIFIC (belongs in config).
Blocker types: architecture-level · extraction-level · source-specific ·
operator workflow · infrastructure.

---

## 1. Current architecture summary

```text
registry adapter (config only: identity, docRules, sections, cleanPatterns,
  exclusions, subject/stream vocabularies, crawl politeness)
→ ingestion: crawlSource [fetch (static|browser) → parse HTML → discover
  → retrieve, politeness applied] → checksum-dedup staging (RawDocument)
→ drift: checkDrift per retrieval → NEW | UNCHANGED | CHANGED (+ history)
→ on-demand drift report (counts + per-document detail, monitoring only)
→ extraction: prepare text (HTML incl. tables | PDF + adapter cleaning)
  → dates + eligibility (adapter vocabs) → normalize → validate
  → ExamEdition DRAFT (in-memory)
→ review: save DRAFT → adjudicate UNKNOWN education → VERIFIED | REJECTED
→ publish: map → strict-validate → dry-run (default) → confirmed single
  upsert + receipt (idempotent identity examSlug:year:cycle)
→ CLI: publish (dry-run/confirm), adjudicate, drift-report modes
```

Every stage reads the adapter config; no stage branches on exam identity
(verified by literal scan: only `index.js`, the intentional JEE demo entry,
plus code comments reference an exam name).

---

## 2. Capability matrix

### Source registry

| Capability | Class | Notes |
|---|---|---|
| Registry schema with fail-fast adapter validation | READY | `registry/schema.js`; identity, docRules, sections, exclusions, vocabs, crawl fields |
| Proven config-only onboarding (JEE Main, GATE 2026) | READY | live runs, zero engine branches |

### Fetching

| Capability | Class | Notes |
|---|---|---|
| Static HTML fetch (axios, timeout, redirects, retry+backoff) | READY | `fetchers/httpFetcher.js` |
| JS/browser fetch (Playwright, same contract) | READY | adapter `render` flag selects it |
| Binary/PDF fetch, both strategies, bytes never transcoded | READY | `fetchBinary`, `fetchBinaryViaBrowser` |
| Per-adapter crawl politeness (delay, timeout, retries; bounded; null = fetcher default) | READY | Phase 20; timing/bounds only, no robots.txt observance (known boundary, §4) |

### Discovery & retrieval

| Capability | Class | Notes |
|---|---|---|
| Link-phrase discovery via adapter `docRules` | READY | case-insensitive, first-hit-wins, config-owned phrases |
| Relative-URL resolution, PDF/HTML type inference | READY | `resolveUrl`, `inferTypeFromUrl` |
| Type+render retrieval dispatch (HTML text / PDF Buffer) | READY | `fetchers/documentFetcher.js`, crawl options forwarded |

### Parsing & cleaning

| Capability | Class | Notes |
|---|---|---|
| HTML title/headings/paragraphs/links/tables | READY | tables added generically (Phase 11) |
| PDF text extraction without refetch | READY | `parsePDFBuffer` |
| Adapter-driven PDF cleaning (`cleanPatterns` compiled globally) | READY | Phase 18; engine holds no exam strings; empty config tidies only |

### Extraction

| Capability | Class | Notes |
|---|---|---|
| Registration start/end (labeled + from/to ranges, confidence) | PARTIAL | extraction-level: English labels only; first-date-after-label can pick superseded dates on revised schedules (observed live, GATE page) |
| Education incl. multi-category → UNKNOWN+evidence rule | READY | never overstates a minimum |
| Ordinal-date boilerplate vs class-level signals (e.g. "8th September, 2008" as a password example matching the "8" level) | PARTIAL | extraction-level: observed live (JEE Advanced 2026 bulletin, source unchanged); coexisting noise + real levels conservatively yield UNKNOWN with both excerpts preserved — preferable to guessing, but recall suffers until date-example contexts are suppressed |
| Percentage / age (incl. DOB NEEDS_VERIFICATION) | READY | range-checked, contradictory → null |
| Adapter-driven stream recognition | READY | Phase 19; empty vocab → UNKNOWN, never guessed |
| Adapter-driven subject recognition | READY | Phase 19; explicit list shape, first-entry-wins, out-of-vocab → UNKNOWN |
| Fees / syllabus / exam pattern / application process | MISSING | extraction-level: mentioned as edition-varying, no extractors, no proven schema demand |
| Non-English content (e.g. Hindi headers observed live) | MISSING | extraction-level: signals and patterns are English-only |

### Normalization & validation

| Capability | Class | Notes |
|---|---|---|
| Dates (ISO/DMY/textual, leap-year + 2000–2100 validation, contradiction → null) | READY | `normalizers/dates.js` |
| Education levels (canonical 8–Doctorate set, local copy) | READY | no server imports |
| Strict Exam/ExamEdition/Evidence zod contracts; KNOWN-requires-value, UNKNOWN-never-ineligible; null-epoch-safe publish dates | READY | `.strict()` rejects `month`/unknown keys |

### Staging, drift & review

| Capability | Class | Notes |
|---|---|---|
| Checksum-deduped RawDocument staging, history preserved | READY | `(url, checksum)` identity |
| Drift detection (`checkDrift`: NEW \| UNCHANGED \| CHANGED) | READY | checksum-only, monitoring-only, no triggers |
| On-demand drift report (counts + per-document detail) | READY | shared crawl sequence, no second crawler |
| DRAFT → VERIFIED \| REJECTED lifecycle, pure review validation | READY | terminal states immutable |
| UNKNOWN-with-evidence + operator adjudication with audit trail | PARTIAL | operator workflow: mechanism generic, but only the `education` axis is adjudicable |
| Dead adapter surface (`footerExclusions` zero consumers; `sections` demo-only) | PARTIAL | architecture-level: schema promises config the pipeline ignores |

### Publishing, CLI & onboarding

| Capability | Class | Notes |
|---|---|---|
| Explicit NextStep mapping, nulls preserved, no `month`, null career/exam types | READY | |
| Strict publish validation (production schema not weakened) | READY | |
| Dry-run default, explicit `--confirm`, receipt + idempotency, collection guards | READY | race-safe converge verified by tests |
| Operator CLI (publish, adjudicate, drift-report modes; exit codes; URI precedence) | READY | thin delegation, scanned by tests |
| Multi-exam onboarding readiness | PARTIAL | operator workflow: proven twice config-only, but runs are manual per-exam/per-draft with no batching or scheduling |
| Batch/multi-exam orchestration | MISSING | architecture-level: one adapter per invocation; CLI is single-draft/single-report |
| Scheduled drift surveillance + notifications | MISSING | infrastructure: reports run on demand only |

### Exam-owned (not engine work)

| Capability | Class | Notes |
|---|---|---|
| Identity/URLs, docRules phrases, cleaning patterns, exclusions, vocabularies, crawl tuning, render flag, year/cycle, operator decisions | EXAM-SPECIFIC | correctly live in adapter config / operator input |

**Counts: READY 27 · PARTIAL 5 · MISSING 4 · EXAM-SPECIFIC 1** (37 rows).

---

## 3. What is reusable today

Everything except the rows marked otherwise: fetching (all modes +
politeness), discovery, retrieval, HTML/PDF parsing, adapter-driven
cleaning, date + eligibility extraction with adapter vocabularies, strict
validation, staging, drift detection + on-demand reporting, review/
adjudication mechanics, publish boundary with idempotency, CLI, and the
registry contract. A new JEE/GATE-shaped exam needs exactly one new file
(`registry/exams/<slug>.js`) plus fixtures/tests.

## 4. Current generic limitations

1. Date labels are English-only with first-match-wins on revised schedules
   (extraction-level).
2. Adjudication covers education only (operator workflow).
3. `footerExclusions` unused; `sections` demo-only (architecture-level dead
   config).
4. No politeness beyond timing/bounds: no robots.txt observance (known
   boundary of the Phase 20 scope).
5. No fee/syllabus/pattern extraction, no non-English support
   (extraction-level).
6. No batching, scheduling, or notifications (architecture/infrastructure).
7. Ordinal dates inside unrelated boilerplate (password/date-of-birth
   examples such as "8th September, 2008") match class-level signals, so a
   page containing both noise and a real level (e.g. Class XII) resolves to
   UNKNOWN rather than the true minimum (extraction-level; Phase 29
   observation on an unchanged source).

## 5. What should NOT be generalized yet

- `careerType`/`examType` classification and `month` (product decisions).
- Fee/syllabus/pattern extraction (no schema demand proven yet — adding
  extractors on speculation repeats the hardcoding problem).
- Fuzzy exam matching / automatic conflict resolution (explicitly refused).
- LLM extraction (unneeded while rules + adjudication cover the recall gap).
- Auto-publish / auto-promote / schedulers (refused by phase boundaries).

## 6. Recommended minimum work before batch onboarding

1. Revised-vs-original date disambiguation (or explicit multi-date evidence)
   — last extraction recall gap on observed sources.
2. Percentage/age/stream adjudication contracts (mirror the education one).
3. Batch runner: re-crawl N adapters, aggregate drift reports, never
   auto-publish (architecture-level).
4. Scheduled drift surveillance + change notifications (infrastructure).
5. Third live exam from a distinct board onboarded config-only as proof.
6. Activate-or-remove decision on `footerExclusions`/`sections` dead config.
7. Date-example-context suppression: discount ordinal-date matches occurring
   inside date-of-birth/password/illustrative-example boilerplate before
   level collection, so noise like "8th September, 2008" stops forcing
   genuine single-level pages into UNKNOWN (extraction-level).

## 7. Ready-for-batch-onboarding definition

Batch onboarding may start when **all** hold: (a) items 1–4 of §6 are
implemented with tests; (b) the third live exam of (5) onboards config-only
with a valid DRAFT; (c) scheduled surveillance runs a full cycle with zero
false publishes; (d) operator adjudication queue stays empty-or-trivially-
resolvable per exam. Until then: one exam at a time, dry-run first, human
review before every confirm.

---

## Explicit answer

**Can we now add a new exam primarily through registry configuration +
source verification, or are there still generic engine blockers?**

Yes — for a single exam shaped like the two proven sources (static or
single-render pages, linked bulletins/schedules, English labels), registry
configuration + source verification is sufficient: no engine changes are
expected, unknown values stay UNKNOWN, and the operator workflow
(review → adjudicate → drift-report → dry-run → confirm) covers the rest.
There are **no remaining generic engine blockers on that path**. What
remains is scale, not capability: batch runs, scheduling, broader
adjudication, and recall edges (revised dates, non-English, fee/syllabus)
are what keep *batch* onboarding out of scope.
