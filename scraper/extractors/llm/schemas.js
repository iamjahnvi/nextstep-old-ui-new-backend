// =============================================================================
// scraper/extractors/llm/schemas.js — STEP 7 proposal contract
// =============================================================================
// WHAT: Validation for local-LLM proposals. A proposal is a structured,
//   non-authoritative suggestion — never a value — and it is valid ONLY with
//   complete, mappable evidence. Dependency-free on purpose: the normal
//   scraper path must not gain an LLM dependency.
// CONTRACT:
//   validateProposal(value)
//     -> { valid, issues[], proposal } — proposal is the normalized form:
//        { field, proposedValue, status, rationale, evidence[], model,
//          provider, createdAt }. Unknown keys are rejected.
//   PROPOSAL_STATUSES = ["PROPOSED", "REVIEW_REQUIRED", "REJECTED"].
// EVIDENCE RULE: evidence is a non-empty array of
//   { sourceDocument, pageNumber, section, quotedText }. quotedText must be a
//   non-empty string here; whether it exists verbatim in the supplied context
//   is checked by semanticProposer (which holds the context), not here.
// =============================================================================

const PROPOSAL_STATUSES = ["PROPOSED", "REVIEW_REQUIRED", "REJECTED"];
const PROPOSAL_KEYS = [
  "field",
  "proposedValue",
  "status",
  "rationale",
  "evidence",
  "model",
  "provider",
  "createdAt",
];
const EVIDENCE_KEYS = ["sourceDocument", "pageNumber", "section", "quotedText"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEvidenceEntry(entry, index) {
  const issues = [];
  if (!isPlainObject(entry)) return [`evidence[${index}] must be an object`];
  for (const key of Object.keys(entry)) {
    if (!EVIDENCE_KEYS.includes(key)) issues.push(`evidence[${index}] forbids key "${key}"`);
  }
  if (typeof entry.sourceDocument !== "string" || !entry.sourceDocument) {
    issues.push(`evidence[${index}].sourceDocument must be a non-empty string`);
  }
  if (entry.pageNumber !== null && (!Number.isInteger(entry.pageNumber) || entry.pageNumber < 1)) {
    issues.push(`evidence[${index}].pageNumber must be a positive integer or null`);
  }
  if (entry.section !== null && entry.section !== undefined && typeof entry.section !== "string") {
    issues.push(`evidence[${index}].section must be a string or null`);
  }
  if (typeof entry.quotedText !== "string" || !entry.quotedText.trim()) {
    issues.push(`evidence[${index}].quotedText must be a non-empty string`);
  }
  return issues;
}

function validateProposal(value) {
  const issues = [];
  if (!isPlainObject(value)) {
    return { valid: false, issues: ["proposal must be an object"], proposal: null };
  }
  for (const key of Object.keys(value)) {
    if (!PROPOSAL_KEYS.includes(key)) issues.push(`proposal forbids key "${key}"`);
  }
  if (typeof value.field !== "string" || !value.field) {
    issues.push("field must be a non-empty string");
  }
  if (typeof value.status !== "string" || !PROPOSAL_STATUSES.includes(value.status)) {
    issues.push(`status must be one of ${PROPOSAL_STATUSES.join("|")}`);
  }
  if (typeof value.rationale !== "string" || !value.rationale.trim()) {
    issues.push("rationale must be a non-empty string");
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    issues.push("evidence must be a non-empty array");
  } else {
    value.evidence.forEach((entry, index) => {
      issues.push(...validateEvidenceEntry(entry, index));
    });
  }
  if (typeof value.model !== "string" || !value.model) {
    issues.push("model must be a non-empty string");
  }
  if (typeof value.provider !== "string" || !value.provider) {
    issues.push("provider must be a non-empty string");
  }
  if (value.createdAt !== undefined && Number.isNaN(new Date(value.createdAt).getTime())) {
    issues.push("createdAt must be a valid timestamp when present");
  }
  if (issues.length > 0) {
    return { valid: false, issues, proposal: null };
  }
  return {
    valid: true,
    issues: [],
    proposal: {
      field: value.field,
      proposedValue: "proposedValue" in value ? value.proposedValue : null,
      status: value.status,
      rationale: value.rationale,
      evidence: value.evidence.map((entry) => ({
        sourceDocument: entry.sourceDocument,
        pageNumber: entry.pageNumber === undefined ? null : entry.pageNumber,
        section: entry.section === undefined ? null : entry.section,
        quotedText: entry.quotedText,
      })),
      model: value.model,
      provider: value.provider,
      createdAt:
        value.createdAt === undefined
          ? new Date().toISOString()
          : new Date(value.createdAt).toISOString(),
    },
  };
}

module.exports = {
  PROPOSAL_STATUSES,
  PROPOSAL_KEYS,
  validateProposal,
};
