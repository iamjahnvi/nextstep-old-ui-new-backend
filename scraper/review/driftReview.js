// =============================================================================
// scraper/review/driftReview.js — STEP 8 drift re-review
// =============================================================================
// WHAT: Deterministic comparison of a previously reviewed snapshot against a
//   fresh one (same field/document). Detects meaningful change — moved source,
//   changed content hash, new revision markers, vanished evidence, changed
//   extracted value — and routes to REVIEW_REQUIRED without overwriting
//   anything: both snapshots ride the output, so history stays intact.
// WHY: Official sources move under us (corrigenda, re-uploads, URL changes).
//   A value reviewed last month must not silently survive its evidence
//   disappearing. Drift says "look again", never "here is the new truth".
// TRIGGERS (checked in fixed order for deterministic output):
//   source-changed   : sourceUrl or documentUrl differs.
//   content-changed  : contentHash differs (both present).
//   revision-changed : revision flag differs.
//   evidence-removed : a previous evidence excerpt no longer appears.
//   value-changed    : extracted value differs (JSON, Dates via ISO).
// CONTRACT:
//   compareForDrift({ previous, current })
//     snapshot: { sourceUrl?, documentUrl?, contentHash?, revision?,
//                 evidenceExcerpts?[], value? }.
//     -> { drifted, triggers: [{ type, detail }], decision:
//          "REVIEW_REQUIRED"|"NO_ACTION", previous, current }.
//        No change on any signal -> NO_ACTION with zero triggers. Pure: no
//        I/O, no network, no randomness. Inputs are never mutated.
// GENERICITY: field-agnostic snapshots. No exam names, no thresholds.
// =============================================================================

const DRIFT_TRIGGER_TYPES = [
  "source-changed",
  "content-changed",
  "revision-changed",
  "evidence-removed",
  "value-changed",
];

function normalizeValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = normalizeValue(value[key]);
    return sorted;
  }
  return value === undefined ? null : value;
}

function sameValue(a, b) {
  return JSON.stringify(normalizeValue(a)) === JSON.stringify(normalizeValue(b));
}

function excerptsOf(snapshot) {
  const list = snapshot && Array.isArray(snapshot.evidenceExcerpts) ? snapshot.evidenceExcerpts : [];
  return list.filter((excerpt) => typeof excerpt === "string");
}

function compareForDrift(input = {}) {
  const previous = input.previous || {};
  const current = input.current || {};
  const triggers = [];

  const prevSource = previous.documentUrl || previous.sourceUrl || null;
  const currSource = current.documentUrl || current.sourceUrl || null;
  if (prevSource !== currSource) {
    triggers.push({ type: "source-changed", detail: `source moved from ${prevSource} to ${currSource}` });
  }
  if (
    previous.contentHash !== null &&
    previous.contentHash !== undefined &&
    current.contentHash !== null &&
    current.contentHash !== undefined &&
    previous.contentHash !== current.contentHash
  ) {
    triggers.push({ type: "content-changed", detail: "document content hash differs" });
  }
  if (Boolean(previous.revision) !== Boolean(current.revision)) {
    triggers.push({
      type: "revision-changed",
      detail: current.revision ? "document newly marked revised" : "revision marker removed",
    });
  }
  const prevExcerpts = excerptsOf(previous);
  const currExcerpts = excerptsOf(current);
  const removed = prevExcerpts.filter((excerpt) => !currExcerpts.includes(excerpt));
  if (removed.length > 0) {
    triggers.push({ type: "evidence-removed", detail: `${removed.length} previous evidence excerpt(s) no longer present` });
  }
  if (!sameValue(previous.value, current.value)) {
    triggers.push({ type: "value-changed", detail: "extracted value differs from the reviewed snapshot" });
  }

  triggers.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  const drifted = triggers.length > 0;
  return {
    drifted,
    triggers,
    decision: drifted ? "REVIEW_REQUIRED" : "NO_ACTION",
    previous,
    current,
  };
}

module.exports = {
  DRIFT_TRIGGER_TYPES,
  compareForDrift,
};
