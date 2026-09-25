# STEP 24 Report — Operator Resolution Workflow

Operator-controlled remediation for Step 23 freshness reviews: inspect,
explicit UPDATE or RETIRE with provenance, validation before persisting,
immutable audit, persistence across restarts. Detection stays automatic;
nothing here auto-discovers, auto-adopts, publishes, or edits exam data.

## Operator workflow

- **Inspect** (`cli/allowlist.js inspect --review <key>`): read-only review
  state plus linked surveillance observations/baselines. Proven hermetically
  and used live below.
- **UPDATE**: requires operator + reason + evidence.source/verification,
  a known review item, an unacted review+URL pair, URL-syntax and
  https/loopback checks, then a live probe of the EXACT new URL through the
  render-aware transport that must pass the shared document gate; persists
  the new declaration, retires the old URL entry, appends the audit, and
  establishes a fresh baseline for the new URL.
- **RETIRE**: same presence/provenance/review guards (no probe needed —
  nothing new is trusted); marks inactive, preserves URL, observations,
  decision, and provenance; future freshness probes skip it via the
  effective-declaration resolution.
- **Validation rules**: missing operator/reason/evidence → reject; unknown
  review or review-without-item → reject; already-resolved review+URL →
  idempotent no-op; unreachable/invalid new URL → reject with probe reason;
  resulting list over `MAX_BULLETIN_URLS` (5) → reject; unknown old URL →
  reject. Adapters resolve effective declarations as override ?? file, so
  freshness probing honors past resolutions without touching adapter files.

## Provenance & audit

Every resolution records reviewId, candidateId, decision, operator, oldUrl,
newUrl (UPDATE only), reason, evidence, timestamp — appended, never edited.
`updateAudits: 1` and `retireAudits: 1` verified present after a real
restart, alongside both declarations' final URL sets.

## Safety

No automatic URL replacement (redirect targets observed, never adopted —
proven: drift recorded, declaration byte-identical); no redirect adoption;
no automatic discovery (probes only declared/explicit URLs; fetch confinement
asserted); no publishing (no publish imports/calls/writes; production models
refused); adapter files never edited at runtime.

## Persistence

Real MongoDB (official 8.2.6, own dbpath, clean admin-shutdowns between
separate OS processes): UPDATE + RETIRE decisions, both declarations, both
baselines, and both surveillance histories survived restart intact
(`updHistory: [BASELINE]`, live history `[BASELINE]`, audits 1+1). Freshness
checks alone create no declaration records (asserted live: `declarations: 0`
after pure observation runs).

## Tests

12 hermetic tests: inspect read-only, valid UPDATE end-to-end, invalid
targets, provenance/operator rejections, unknown-review rejection, RETIRE
with history preservation, redirect non-adoption + explicit adoption,
idempotency, bounds, dry-run zero writes, batch isolation/caps, observation
shape, CLI parsing, boundary scans, help exit. Full suite green (counts below).

## JEE Main

Live declared CDN bulletin re-probed with default transports: reachable,
valid PDF, **6,092,568 bytes with SHA-256 prefix `b18d5d608dda0a27` —
identical to the Step 23 observation**, so the declaration is stable:
inspect-only, zero mutations, `NO_ACTION` baseline. Controlled UPDATE/RETIRE
proofs ran on clearly labeled synthetic URLs (stub transports); the real
declaration was never modified, retired, or re-pointed.

## Strict boundaries

No extraction/verification/review/publishing changes; no LLM, browser,
queue, cloud, dashboard, or batch work; Step 23 semantics untouched (all
Step 23 tests still green); no Step 25 work.
