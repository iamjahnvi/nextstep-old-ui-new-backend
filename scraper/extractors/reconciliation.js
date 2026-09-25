// =============================================================================
// scraper/extractors/reconciliation.js — STEP 6 cross-document reconciliation
// =============================================================================
// WHAT: Deterministic reconciliation of one field's candidate values across
//   the multiple official documents of an exam/edition (original bulletin,
//   revised bulletin, corrigendum, registration notice). Every source's
//   evidence is preserved; a value is selected ONLY when the evidence
//   deterministically resolves it — otherwise the conflict stays visible for
//   review instead of being silently overwritten.
// WHY: Later documents do not automatically supersede earlier ones. A revised
//   schedule explicitly replaces its original; two unrelated pages disagreeing
//   is a conflict to surface, not a race for last-write-wins.
// RULES (deterministic, order-independent):
//   - No evidenced (non-null) values → INSUFFICIENT_EVIDENCE.
//   - One distinct value (even from a single document) → RESOLVED
//     ("unanimous" / "single evidenced source").
//   - Several distinct values → RESOLVED only when exactly one candidate is
//     explicitly marked revised/corrigendum AND it is the newest by fetchedAt
//     (reason "explicit revision supersedes"); otherwise CONFLICT with every
//     candidate's evidence preserved ("distinct values without explicit
//     revision").
//   - Dates compare by ISO instant (Date objects and ISO strings unify); all
//     other values compare by JSON with sorted keys.
//   - STEP 7 LLM riders: candidates with origin "LLM" are carried in
//     llmProposals (authoritative: false) but excluded from every decision —
//     they can neither manufacture unanimity nor win a revision, and the
//     deterministic evidence stays authoritative.
// CONTRACT:
//   reconcileField({ field, candidates })
//     candidates: [{ value, evidence, docLabel?, sourceUrl?, documentUrl?,
//                    fetchedAt?, revision?: boolean }]
//     -> { field, status: "RESOLVED"|"CONFLICT"|"INSUFFICIENT_EVIDENCE",
//          selectedValue, reason, candidates: [...sorted copy...], evidence }.
//        evidence = the evidence entries behind the decision (all of them on
//        CONFLICT/unanimous; the winning one on revision — the superseded
//        entries stay on their candidates, never deleted).
// GENERICITY: field-agnostic (dates, levels, any JSON value). No exam names.
// =============================================================================

const RESOLUTION_STATUSES = ["RESOLVED", "CONFLICT", "INSUFFICIENT_EVIDENCE"];

function normalizeValue(value) {
  if (value instanceof Date) return { __date: value.toISOString() };
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = normalizeValue(value[key]);
    return sorted;
  }
  return value;
}

function sameValue(a, b) {
  return JSON.stringify(normalizeValue(a)) === JSON.stringify(normalizeValue(b));
}

function candidateKey(candidate, index) {
  return [candidate.documentUrl || "", candidate.docLabel || "", candidate.sourceUrl || "", index].join("|");
}

function reconcileField(input = {}) {
  const field = typeof input.field === "string" && input.field ? input.field : "field";
  const list = Array.isArray(input.candidates) ? input.candidates : [];
  const ordered = [...list].sort((a, b) =>
    candidateKey(a, 0) < candidateKey(b, 0) ? -1 : 1
  );
  // STEP 7: LLM-origin candidates ride along for review but never vote. The
  // deterministic outcome below is computed as if they were absent, so a
  // proposal can neither manufacture unanimity nor trigger a revision win.
  const llmRiders = ordered.filter((c) => c && c.origin === "LLM");
  const authoritative = ordered.filter((c) => !(c && c.origin === "LLM"));
  const llmProposals = llmRiders.map((c) => ({
    value: c.value === undefined ? null : c.value,
    authoritative: false,
    proposal: c.proposal === undefined ? null : c.proposal,
  }));
  const evidenced = authoritative.filter((c) => c && c.value !== null && c.value !== undefined);

  if (evidenced.length === 0) {
    return {
      field,
      status: "INSUFFICIENT_EVIDENCE",
      selectedValue: null,
      reason: "no evidenced values to reconcile",
      candidates: ordered,
      evidence: [],
      llmProposals,
    };
  }

  const distinct = [];
  for (const candidate of evidenced) {
    if (!distinct.some((seen) => sameValue(seen.value, candidate.value))) distinct.push(candidate);
  }
  const evidenceOf = (candidates) =>
    candidates.map((c) => c.evidence).filter((e) => e !== null && e !== undefined);

  if (distinct.length === 1) {
    return {
      field,
      status: "RESOLVED",
      selectedValue: distinct[0].value,
      reason: evidenced.length === 1 ? "single evidenced source" : "unanimous across documents",
      candidates: ordered,
      evidence: evidenceOf(evidenced),
      llmProposals,
    };
  }

  const revised = distinct.filter((c) => c.revision === true);
  if (revised.length === 1) {
    const winner = revised[0];
    const winnerTime = winner.fetchedAt ? new Date(winner.fetchedAt).getTime() : NaN;
    const newerExists = distinct.some((other) => {
      if (other === winner) return false;
      const otherTime = other.fetchedAt ? new Date(other.fetchedAt).getTime() : NaN;
      return !Number.isNaN(winnerTime) && !Number.isNaN(otherTime) && otherTime > winnerTime;
    });
    if (!newerExists) {
      return {
        field,
        status: "RESOLVED",
        selectedValue: winner.value,
        reason: "explicit revision supersedes earlier documents",
        candidates: ordered,
        evidence: evidenceOf([winner]),
        llmProposals,
      };
    }
  }

  return {
    field,
    status: "CONFLICT",
    selectedValue: null,
    reason: "distinct values without explicit revision",
    candidates: ordered,
    evidence: evidenceOf(evidenced),
    llmProposals,
  };
}

module.exports = {
  RESOLUTION_STATUSES,
  reconcileField,
};
