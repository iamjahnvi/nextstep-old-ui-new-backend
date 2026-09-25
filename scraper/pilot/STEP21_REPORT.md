# STEP 21 Report — Observed Bulletin-URL Fallback Probe

Bounded discovery fallback only. No extraction, review, publish, or transport
redesigns; `httpFetcher`, `browserFetcher`, `crawleeTransport` byte-identical.
Live run used an isolated staging database; zero production writes, zero
publishes. Raw run JSON: `pilot/results/step21-jeemain.*.json` (gitignored).

## Discovery behavior

Previous limitation: `discoverFromSource` defaulted to plain HTTP, and Step 9
passed no adapter context — js sources failed discovery outright; and even
through the browser, an unlabeled bulletin link escapes scoring while the
run stops at whatever was found.

Exact fallback rule (`discovery/bulletinFallback.js`, js adapters only, after
normal discovery yields no BULLETIN/adapter-matched document): re-fetch the
source landing page through the render-aware selector (one bounded fetch),
collect same-domain links, rank adapter-rule hits (0) above bulletin-URL
keywords (1) above other observed PDFs (2), skip boilerplate/off-domain/
already-discovered, probe at most 3 (`DEFAULT_MAX_CANDIDATES`) through
`fetchDocumentForAdapter`, and accept only reachable, valid documents (PDF:
non-empty bytes with %PDF magic or pdf content-type; HTML: adapter-rule hit
on the final URL). Every candidate records derivedFrom/pattern/reachability/
acceptance/reason; failures never throw; static adapters skip entirely
(`needsBulletinFallback` false → stages.fallback `skipped`, flow identical).

## Regression (9 tests, all passing)

Normal discovery winning suppresses the fallback; missing bulletins derive
ranked observed-only candidates; unreachable/invalid candidates fail closed
with reasons; 8 PDFs cap to configured bound; static flows untouched
(predicate false; Step 9 static suites green); js browser transport remains
authoritative; no exam names, no hardcoded bulletin paths.

## JEE Main live re-test (`jee-main`, `render: "js"`, 51 s)

- Browser accessibility: landing 200 via pooled browser (plain HTTP still
  403); 119 links seen; 4 documents discovered, all fetched 200.
- Normal discovery result: 2× NOTIFICATION, 1× SYLLABUS, 1× paginated
  notices — no bulletin, no adapter hit → fallback TRIGGERED (predicate true).
- Fallback candidates: none derived — the re-fetched landing exposed no
  same-domain PDFs and no adapter-rule-matching URLs → status `empty`,
  zero probes, zero accepted. Correct conservative outcome, fully evidenced.
- PDF capture result: not exercised live (nothing to capture); proven
  locally with byte-identical capture instead.
- Downstream: validation ok → review REQUIRED (registration nulls honest;
  education Graduate/MEDIUM flagged investigate — excerpt suggests
  result-declaration boilerplate, not eligibility prose) → draft `DRAFT`,
  unpublished, 0 production writes. Operator verdict: PASS_WITH_REVIEW.

## Separated claims

- TRANSPORT VERIFIED: js discovery + fetch ride the pooled browser (local
  UA proof + live 200s where HTTP 403s); static byte-identical.
- DISCOVERY FALLBACK VERIFIED: trigger/suppress logic, observed-only
  derivation, bounds, fail-closed probing (unit + live-empty case).
- SOURCE ACCESS VERIFIED (partial, unchanged from Step 20): landing + HTML
  live; bulletin PDF leg still unobserved live.
- DOCUMENT VERIFIED: no — no bulletin/PDF was reachable to verify; the
  fallback correctly declined to fabricate one.
- PIPELINE VERIFIED (seam only): shapes unchanged, downstream untouched.

## Remaining limitations → recommended Step 22

Fallback can only re-examine what the fetched HTML contains — script-fetched
bulletin menus outside the DOM stay invisible; multi-page bulletin hunts are
out of scope by bound. Recommended Step 22 (observed-only): adapter-declared
bulletin URL allowlist (exact configured paths, probed not crawled), then
this exact protocol — no architecture change.
