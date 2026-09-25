// =============================================================================
// scraper/validators/confidence.js — STEP 8 generalized confidence evaluator
// =============================================================================
// WHAT: Deterministic confidence grading for one extracted field candidate,
//   built from signals the pipeline already produces: the extractor's own
//   evidence (with its confidence), the extraction status, supporting-source
//   count, explicit revision markers, conflicts, and LLM-only provenance.
// WHY: Later stages need to know which fields are strong and which need eyes.
//   Confidence here is an explicit rule ladder, never a probability: the same
//   inputs always yield the same level, with reasons attached for audit.
// LADDER (evaluated in order; first terminal rule wins unless capped):
//   UNKNOWN : no usable evidence (null evidence, or status UNKNOWN with no
//             value claimed and no informative evidence).
//   LOW     : capped — conflict over the value, LLM-only provenance, status
//             NEEDS_VERIFICATION, or status UNKNOWN with preserved ambiguity.
//   HIGH    : status KNOWN (or RESOLVED) with extractor confidence HIGH, plus
//             at least one strengthener: page number present, 2+ supporting
//             sources, or explicit revision/corrigendum evidence.
//   MEDIUM  : KNOWN/RESOLVED with extractor confidence MEDIUM, or HIGH without
//             any strengthener (strong signal, thin corroboration).
//   Caps override everything: conflict and LLM-only provenance cap at LOW —
//   a disputed or machine-suggested value is never strong, however it reads.
// CONTRACT:
//   evaluateFieldConfidence(input)
//     input: { status?, evidence?, sourcesCount?, revision?, conflict?,
//              llmOnly? } — evidence is an Evidence-shaped object or null.
//     -> { confidence: "HIGH"|"MEDIUM"|"LOW"|"UNKNOWN", reasons: [string] }.
// GENERICITY: field-agnostic. No exam names, no field-specific thresholds.
// =============================================================================

const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW", "UNKNOWN"];

function extractorConfidence(evidence) {
  const level = evidence && typeof evidence.confidence === "string" ? evidence.confidence : null;
  return CONFIDENCE_LEVELS.includes(level) ? level : null;
}

function evaluateFieldConfidence(input = {}) {
  const reasons = [];
  const status = typeof input.status === "string" ? input.status : "UNKNOWN";
  const evidence = input.evidence === undefined ? null : input.evidence;
  const sourcesCount =
    typeof input.sourcesCount === "number" && input.sourcesCount >= 0 ? Math.floor(input.sourcesCount) : 0;
  const revision = input.revision === true;
  const conflict = input.conflict === true;
  const llmOnly = input.llmOnly === true;

  if (!evidence) {
    return { confidence: "UNKNOWN", reasons: ["no evidence attached"] };
  }
  if (conflict) {
    return { confidence: "LOW", reasons: ["conflicting values cap confidence at LOW"] };
  }
  if (llmOnly) {
    return { confidence: "LOW", reasons: ["LLM-only provenance caps confidence at LOW"] };
  }
  if (status === "NEEDS_VERIFICATION") {
    return { confidence: "LOW", reasons: ["status NEEDS_VERIFICATION caps confidence at LOW"] };
  }
  if (status === "UNKNOWN") {
    return { confidence: "LOW", reasons: ["ambiguous evidence preserved without a claimed value"] };
  }

  const base = extractorConfidence(evidence);
  if (base === "LOW") {
    reasons.push("extractor confidence is LOW");
    return { confidence: "LOW", reasons };
  }

  const strengtheners = [];
  if (evidence.page !== null && evidence.page !== undefined) strengtheners.push("page number present");
  if (evidence.section !== null && evidence.section !== undefined) strengtheners.push("section context present");
  if (sourcesCount >= 2) strengtheners.push(`${sourcesCount} supporting sources`);
  if (revision) strengtheners.push("explicit revision/corrigendum evidence");

  const effective = base || "MEDIUM";
  if (base === null) reasons.push("no extractor confidence stated; treating as MEDIUM");
  if (effective === "HIGH" && strengtheners.length > 0) {
    reasons.push(`extractor confidence HIGH (${strengtheners.join(", ")})`);
    return { confidence: "HIGH", reasons };
  }
  if (effective === "HIGH") {
    reasons.push("extractor confidence HIGH without corroborating strengtheners");
    return { confidence: "MEDIUM", reasons };
  }
  reasons.push("extractor confidence MEDIUM");
  return { confidence: "MEDIUM", reasons };
}

module.exports = {
  CONFIDENCE_LEVELS,
  evaluateFieldConfidence,
};
