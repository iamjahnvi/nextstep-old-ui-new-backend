# Exam Discovery (STEP 2)

## What DISCOVERED means

> **DISCOVERED** — the system found a potential exam candidate on a configured
> discovery source. The candidate has **not** been verified as an authoritative
> exam source. It is an evidenced guess, not a fact.

Every candidate answers "why do you exist?" with evidence: seed id, source
URL, source title, matched text, matched URL, matched pattern, retrieval time.
A candidate carries **no** official/verified flag — such a field does not exist
on the schema, so it cannot be set by accident.

## Lifecycle boundary (non-negotiable)

```text
Discovery  ≠  Verification  ≠  Crawling  ≠  Extraction  ≠  Publishing
```

* Discovery (`discovery/examDiscovery.js`) reads seed pages and emits
  `DISCOVERED` candidates into `scraper_exam_candidates`. It never fetches a
  candidate's own site beyond the seed page, never extracts dates/eligibility,
  never verifies authority.
* Verification, profiling, candidate crawling, and promotion arrive in later
  steps. `transitionCandidateStatus()` currently rejects every forward
  transition; the status enum is `DISCOVERED`-only until those steps land.
* Publishing is unreachable: `publish/publishExecutor.js` only reads staging
  drafts from `scraper_editiondrafts` (collection-guarded) and writes only the
  production `exams` collection. Passing a candidate model is refused before
  any draft lookup — locked by `tests/examDiscovery.test.js` §8.

## Concepts (do not mix them)

| Document | Collection | Meaning |
|---|---|---|
| ExamCandidate | `scraper_exam_candidates` | "we found something" |
| ExamEditionDraft | `scraper_editiondrafts` | "we crawled + extracted structured data" |
| Exam | `exams` (production) | "verified, published NextStep data" |

## Seeds

`registry/discovery/seeds.js` — configuration only. Five enabled `authority`
seeds, every URL already present in this repository (3 scraper-verified adapter
sites + 2 `server/data/exams.js` official sites, provenance noted per seed).
Match rules are generic English signals (`\bexaminations?\b`, …) with
word boundaries — never exam names. `directory`/`calendar` seed types are
reserved for future verified additions; no placeholder URLs are listed.

## Identity

`candidateId = dsc-sha256(normalizedName|yearOrUnknown)[0:16]`. Light
normalization (case/whitespace/punctuation) keeps distinct exams apart; the
year keeps editions (`…2026` vs `…2027`) apart. Re-sightings — same or
different seed — merge evidence into one document instead of duplicating.
Unknowns stay `null`: year, conducting body, description, and officiality are
never guessed.

## What Step 2 does NOT do

Source verification, source profiling, candidate crawling, adapter generation,
PDF/Docling/OCR/Python/LLM work, date/eligibility extraction, normalization or
publishing changes. The discovery transport is the existing `httpFetcher`
(injectable for tests); Crawlee is neither required nor wired in.
