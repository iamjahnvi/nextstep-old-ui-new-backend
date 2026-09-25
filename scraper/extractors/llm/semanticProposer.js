// =============================================================================
// scraper/extractors/llm/semanticProposer.js — STEP 7 optional local proposer
// =============================================================================
// WHAT: Disabled-by-default local-LLM fallback for genuinely ambiguous
//   extraction cases. Takes the ambiguous span plus the FULL document context
//   it may cite, asks a local provider for a structured proposal, then
//   verifies every citation against the supplied context before returning.
//   Produces proposals for human review — never values, never overrides.
// WHY: Deterministic rules honestly report UNKNOWN on some spans; a local
//   model may suggest a reading, but only with mappable evidence and only
//   when the deterministic layer has nothing authoritative to protect.
// GATES (in order — a closed gate returns without touching any provider):
//   1. Feature flag: options.enabled ?? LLM_SEMANTIC_EXTRACTION === "true".
//      Default false: no process starts, no network occurs, nothing changes.
//   2. Deterministic authority: options.deterministic with status "KNOWN" or
//      "RESOLVED" (and any value, including null-valued KNOWNs) blocks the
//      call — an authoritative result is never re-asked.
// PRECEDENCE: DETERMINISTIC VERIFIED RESULT > LLM PROPOSAL > UNKNOWN. The
//   proposer enforces the first half (gate 2); callers enforce the second by
//   keeping proposals marked non-authoritative (see reconciliation.js).
// CITATION RULE: every evidence.quotedText must occur in the supplied
//   documentContext text (whitespace-collapsed comparison), and
//   evidence.sourceDocument must equal the context's sourceDocument. A
//   pageNumber, when the context declares pageCount, must fall inside it.
//   Any failure downgrades to { status: "REVIEW_REQUIRED", proposedValue:
//   null } — fabricated citations never survive as proposals.
// CONTRACT:
//   proposeField({ field, ambiguousSpan, documentContext, deterministic,
//                  provider, options })
//     documentContext: { text, sourceDocument, pageCount? } (text required).
//     deterministic: null | { status, value } — KNOWN/RESOLVED blocks.
//     provider: { name, complete({ system, user, model? }) -> { text } }
//       (OllamaProvider below; tests inject a mock — Ollama is never required).
//     options: { enabled?, model?, timeoutMs? }.
//     -> { invoked: false, reason } when gated, else
//        { invoked: true, ok: true, proposal } or
//        { invoked: true, ok: false, error: { type, retryable, detail } }.
//        Provider failures are structured data, never throws (except missing
//        field/context, which are programmer errors).
// PROMPT RULES (sent to every provider): supplied-context-only, no invented
//   dates/requirements/levels, null when insufficient, exact quotes, JSON only.
// GENERICITY: field-agnostic. No exam names, no field-specific logic.
// =============================================================================

const { validateProposal } = require("./schemas");

const FEATURE_FLAG = "LLM_SEMANTIC_EXTRACTION";
const DEFAULT_TIMEOUT_MS = 60000;
const DETERMINISTIC_FINAL_STATUSES = ["KNOWN", "RESOLVED"];

const SYSTEM_PROMPT = [
  "You are a cautious extraction assistant for official exam documents.",
  "Rules you must obey:",
  "1. Use ONLY the supplied document context. Never use general knowledge.",
  "2. Never infer missing dates, eligibility requirements, or education levels.",
  "3. Never derive an education level from an unrelated number or date.",
  "4. If the evidence is insufficient, set proposedValue to null.",
  "5. Every evidence entry must quote the source text EXACTLY as written.",
  "6. Reply with JSON only: { proposedValue, status, rationale, evidence }. " +
    "status is PROPOSED, REVIEW_REQUIRED, or REJECTED. " +
    "evidence is an array of { sourceDocument, pageNumber, section, quotedText }.",
].join("\n");

function isEnabled(options = {}) {
  if (typeof options.enabled === "boolean") return options.enabled;
  return process.env[FEATURE_FLAG] === "true";
}

function collapse(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function buildUserPrompt({ field, ambiguousSpan, documentContext, deterministic }) {
  const parts = [
    `Field under consideration: ${field}`,
    `Ambiguous span: ${JSON.stringify(String(ambiguousSpan || ""))}`,
    `Deterministic layer result: ${deterministic ? `${deterministic.status} (${JSON.stringify(deterministic.value === undefined ? null : deterministic.value)})` : "none"}`,
    "Full document context you may cite (cite ONLY from this text):",
    "---",
    String((documentContext && documentContext.text) || ""),
    "---",
  ];
  return parts.join("\n");
}

function verifyCitations(proposal, documentContext) {
  const issues = [];
  const contextText = collapse(documentContext.text);
  const contextDoc = documentContext.sourceDocument;
  const pageCount = documentContext.pageCount;
  proposal.evidence.forEach((entry, index) => {
    if (!collapse(entry.quotedText) || !contextText.includes(collapse(entry.quotedText))) {
      issues.push(`evidence[${index}].quotedText not found verbatim in the supplied context`);
    }
    if (entry.sourceDocument !== contextDoc) {
      issues.push(`evidence[${index}].sourceDocument does not match the supplied context`);
    }
    if (
      entry.pageNumber !== null &&
      entry.pageNumber !== undefined &&
      Number.isInteger(pageCount) &&
      (entry.pageNumber < 1 || entry.pageNumber > pageCount)
    ) {
      issues.push(`evidence[${index}].pageNumber is outside the context page range`);
    }
  });
  return issues;
}

class OllamaProvider {
  // Local-only provider. No API keys, no cloud endpoints. Configured, never
  // hardcoded: LLM_PROVIDER_URL (default http://127.0.0.1:11434), LLM_MODEL.
  constructor(options = {}) {
    this.name = "ollama";
    this.baseUrl = options.baseUrl || process.env.LLM_PROVIDER_URL || "http://127.0.0.1:11434";
    this.model = options.model || process.env.LLM_MODEL || "";
    this.timeoutMs = typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  async complete({ system, user, model }) {
    const chosen = model || this.model;
    if (!chosen) throw new Error("ollama provider: LLM_MODEL is not configured");
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: chosen, prompt: `${system}\n\n${user}`, stream: false, format: "json" }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const error = new Error(`ollama provider: HTTP ${response.status}`);
      error.retryable = response.status >= 500;
      throw error;
    }
    const body = await response.json();
    return { text: body.response || "", model: chosen };
  }
}

function reviewRequired(field, providerName, model, reason, evidenceHint) {
  return {
    invoked: true,
    ok: true,
    proposal: {
      field,
      proposedValue: null,
      status: "REVIEW_REQUIRED",
      rationale: reason,
      evidence: evidenceHint || [],
      model: model || "unknown",
      provider: providerName || "unknown",
      createdAt: new Date().toISOString(),
    },
  };
}

async function proposeField(input = {}) {
  const { field, ambiguousSpan, documentContext, deterministic, provider, options } = input;
  if (typeof field !== "string" || !field) {
    throw new Error("semanticProposer: field is required");
  }
  if (!documentContext || typeof documentContext.text !== "string" || !documentContext.sourceDocument) {
    throw new Error("semanticProposer: documentContext with text and sourceDocument is required");
  }
  const opts = options || {};

  if (!isEnabled(opts)) {
    return { invoked: false, reason: "disabled (LLM_SEMANTIC_EXTRACTION is not true)" };
  }
  if (
    deterministic &&
    DETERMINISTIC_FINAL_STATUSES.includes(deterministic.status)
  ) {
    return { invoked: false, reason: `deterministic result is authoritative (${deterministic.status})` };
  }
  if (!provider || typeof provider.complete !== "function") {
    return {
      invoked: true,
      ok: false,
      error: { type: "no-provider", retryable: false, detail: "no local provider configured" },
    };
  }

  const providerName = provider.name || "local";
  const model = opts.model || provider.model || "unknown";
  let raw;
  try {
    raw = await provider.complete({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt({ field, ambiguousSpan, documentContext, deterministic }),
      model: opts.model || provider.model,
    });
  } catch (error) {
    const timedOut = error && (error.name === "TimeoutError" || /timeout|aborted/i.test((error && error.message) || ""));
    return {
      invoked: true,
      ok: false,
      error: {
        type: timedOut ? "provider-timeout" : "provider-error",
        retryable: timedOut || error.retryable === true,
        detail: (error && error.message) || String(error),
      },
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(String((raw && raw.text) || ""));
  } catch {
    return reviewRequired(field, providerName, (raw && raw.model) || model, "provider returned non-JSON output");
  }

  const check = validateProposal({
    field,
    proposedValue: "proposedValue" in parsed ? parsed.proposedValue : null,
    status: parsed.status,
    rationale: parsed.rationale,
    evidence: parsed.evidence,
    model: (raw && raw.model) || model,
    provider: providerName,
  });
  if (!check.valid) {
    return reviewRequired(
      field,
      providerName,
      (raw && raw.model) || model,
      `proposal failed contract validation: ${check.issues.join("; ")}`
    );
  }

  const citationIssues = verifyCitations(check.proposal, documentContext);
  if (citationIssues.length > 0) {
    return reviewRequired(
      field,
      providerName,
      check.proposal.model,
      `citation verification failed: ${citationIssues.join("; ")}`
    );
  }

  return { invoked: true, ok: true, proposal: check.proposal };
}

module.exports = {
  FEATURE_FLAG,
  DETERMINISTIC_FINAL_STATUSES,
  SYSTEM_PROMPT,
  isEnabled,
  verifyCitations,
  OllamaProvider,
  proposeField,
};
