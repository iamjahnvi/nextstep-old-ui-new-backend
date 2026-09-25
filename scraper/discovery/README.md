# Exam Discovery (STEP 2) + Source Verification & Profiling (STEP 3)

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
* Verification and profiling are Step 3 (`discovery/sourceVerification.js`,
  `discovery/sourceProfiler.js`, results in `scraper_source_profiles`). They
  decide only `SOURCE_VERIFIED` vs `SOURCE_REVIEW_REQUIRED` plus a technical
  profile — never content truth, never promotion.
* Candidate crawling, extraction, and promotion arrive in later steps.
  `transitionCandidateStatus()` still rejects every forward transition; the
  only status writer is `applyVerification()`, and only from `DISCOVERED`.
* Publishing is unreachable: `publish/publishExecutor.js` only reads staging
  drafts from `scraper_editiondrafts` (collection-guarded) and writes only the
  production `exams` collection. Passing a candidate model is refused before
  any draft lookup — locked by `tests/examDiscovery.test.js` §8.

## Concepts (do not mix them)

| Document | Collection | Meaning |
|---|---|---|
| ExamCandidate | `scraper_exam_candidates` | "we found something" (`DISCOVERED` → `SOURCE_VERIFIED` / `SOURCE_REVIEW_REQUIRED`) |
| SourceProfile | `scraper_source_profiles` | "what we proved about its source + what it technically is" |
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

## Step 3 — verification & profiling

**Verification** (`discovery/sourceVerification.js`) proves a source/domain
relationship, never exam truth. `SOURCE_VERIFIED` requires the full
conjunction, every signal persisted: exact domain in trusted configuration
(adapter official host or `registry/discovery/authorities.js` mapping) **and**
conducting-body corroboration **and** https. Gov-looking domains, seed
coincidence, and https alone are recorded as supporting context — never proof.
Anything short resolves to `SOURCE_REVIEW_REQUIRED` with reasons. Authority
mappings are strictly repo-derived (3 live-verified adapters); NEET/UPSC have
no mapping yet, so those candidates correctly need review.

**Profiling** (`discovery/sourceProfiler.js`) is pure and fetch-free:
`STATIC_HTML | JAVASCRIPT_HTML | PDF | MIXED | UNKNOWN` with transport
`HTTP | BROWSER | UNKNOWN`, document types, and `requiresJavaScript`
(true/false/null=unknown). Direct PDF URLs win; trusted adapter `render`
outranks page-shape guessing; only strong SPA markers (not generic scripts)
imply JS rendering; no signal means `UNKNOWN`, never an assumption. Profiles
never change candidate status.

## Step 4 — broader document discovery

**Discovery** (`discovery/documentDiscovery.js`) ranks relevant pages/documents
for a `SOURCE_VERIFIED` source — anything else throws. Two entry points: the
pure `discoverDocumentsFromPages()` over supplied pages, and
`discoverFromSource()` (bounded BFS over an injectable page fetcher; default
the existing `httpFetcher`).

Categories: `BULLETIN | NOTIFICATION | CORRIGENDUM | REGISTRATION |
ELIGIBILITY | SYLLABUS | EXAM_PATTERN | IMPORTANT_DATES | APPLICATION |
RESULT | OTHER`. Scoring is fixed and deterministic: link-text hit +3,
URL hit +2, revision marker +1, adapter-docRule hit +2 (same substring
semantics as `sourceDiscovery`), boilerplate −10 and dropped; threshold ≥ 2
keeps, ties break in category-priority order. Unlike first-match-wins
discovery, **every** qualifying link is preserved — original, revised, and
corrigendum stay separately discoverable for later authoritativeness calls.

Bounds (no uncontrolled crawling): `maxDepth` (default 1), `maxPages`
(default 5), `maxDocuments` (default 50), `sameDomainOnly` (default true);
traversal follows only relevant non-PDF same-domain links; output sorts by
score desc, then URL asc. Each document carries `url, sourceUrl, label, title,
documentType, relevanceScore, matchedSignals, discoveredAt, depth` — the
answer to "why was this discovered?". Discovered documents are **not**
authority-verified and carry **no** extracted exam fields.

## What Steps 2–4 do NOT do

Candidate crawling for content, adapter generation, PDF/Docling/OCR/Python/LLM
work, date/eligibility extraction, normalization or publishing changes.
Crawlee is neither required nor wired into discovery.
