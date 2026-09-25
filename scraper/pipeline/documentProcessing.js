// =============================================================================
// scraper/pipeline/documentProcessing.js — STEP 5 Node integration layer
// =============================================================================
// WHAT: Thin dispatcher between the Node pipeline and the stateless Python
//   document processor (scraper/python-docproc). Decides (deterministically,
//   from the raw document + source profile) whether Python is needed, posts
//   bytes + metadata, validates the GENERIC representation, and returns it —
//   or a structured error envelope on failure. No extraction, no validation
//   of exam entities, no exam logic of any kind lives here.
// WHY: Python runs only where its document ecosystem earns it. Ordinary HTML
//   stays on the existing Node path; PDFs flagged by the source profile go to
//   Python for pages/blocks/tables/reading-order structure that Node's
//   flat-text parser cannot provide.
// INVOCATION RULE (deterministic):
//   usePython = rawDoc.type === "PDF" AND (no profile given OR
//   profile.type is "PDF" or "MIXED"). Everything else stays on Node.
//   A profile of STATIC_HTML/JAVASCRIPT_HTML/UNKNOWN never routes to Python.
// CONTRACTS:
//   shouldUsePython(rawDoc, profile?) -> { usePython, reason }.
//   processWithPython(rawDoc, { serviceUrl?, timeoutMs? })
//     -> { ok: true, representation } | { ok: false, error }.
//        error = { type, processor, url, detail, retryable, timestamp }.
//        Never throws on transport/validation failure (only on missing args).
//   processDocument(rawDoc, options?)
//     -> { ok: true, handled: false, path: "node", reason } for Node-path
//        documents, else the processWithPython envelope.
//   validateRepresentation(value) -> { valid, issues[] } — generic shape only.
// FAILURE POLICY: failures are data, not crashes. Timeouts, refused
//   connections, 5xx, and unreadable PDFs are retryable:true; 4xx and
//   contract violations are retryable:false. Nothing is ever invented: a
//   failed document yields an error envelope, never a guessed representation.
// =============================================================================

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8001";
const DEFAULT_TIMEOUT_MS = 30000;
const PYTHON_PROFILE_TYPES = ["PDF", "MIXED"];

function serviceUrlOf(options = {}) {
  if (typeof options.serviceUrl === "string" && options.serviceUrl) return options.serviceUrl;
  if (typeof process.env.PYTHON_DOCPROC_URL === "string" && process.env.PYTHON_DOCPROC_URL) {
    return process.env.PYTHON_DOCPROC_URL;
  }
  return DEFAULT_SERVICE_URL;
}

function shouldUsePython(rawDoc, profile) {
  if (!rawDoc || rawDoc.type !== "PDF") {
    return { usePython: false, reason: "only PDF documents route to Python" };
  }
  if (profile === undefined || profile === null) {
    return { usePython: true, reason: "PDF without a profile defaults to specialist processing" };
  }
  if (PYTHON_PROFILE_TYPES.includes(profile.type)) {
    return { usePython: true, reason: `source profile "${profile.type}" needs specialist processing` };
  }
  return { usePython: false, reason: `source profile "${profile.type}" stays on the Node path` };
}

const FORBIDDEN_EXAM_KEYS = [
  "examName",
  "registrationStart",
  "registrationEnd",
  "eligibility",
  "subjects",
  "educationLevel",
];

function collectKeys(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, into);
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      into.add(key);
      collectKeys(value[key], into);
    }
  }
  return into;
}

function validateRepresentation(value) {
  const issues = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, issues: ["representation must be an object"] };
  }
  const forbidden = [...collectKeys(value)].filter((key) => FORBIDDEN_EXAM_KEYS.includes(key));
  if (forbidden.length > 0) {
    issues.push(`representation must not carry exam fields: ${forbidden.join(", ")}`);
  }
  if (typeof value.documentType !== "string") issues.push("documentType must be a string");
  if (!Number.isInteger(value.pageCount) || value.pageCount < 0) {
    issues.push("pageCount must be a non-negative integer");
  }
  if (!Array.isArray(value.pages)) {
    issues.push("pages must be an array");
  } else {
    value.pages.forEach((page, index) => {
      if (!page || typeof page !== "object") {
        issues.push(`pages[${index}] must be an object`);
        return;
      }
      if (page.pageNumber !== index + 1) {
        issues.push(`pages[${index}].pageNumber must be ${index + 1} (reading order)`);
      }
      if (!Array.isArray(page.blocks)) issues.push(`pages[${index}].blocks must be an array`);
      if (!Array.isArray(page.tables)) issues.push(`pages[${index}].tables must be an array`);
    });
    if (Number.isInteger(value.pageCount) && value.pages.length !== value.pageCount) {
      issues.push("pages.length must equal pageCount");
    }
  }
  if (!Array.isArray(value.warnings)) issues.push("warnings must be an array");
  if (!value.processor || typeof value.processor !== "object") {
    issues.push("processor metadata must be an object");
  } else {
    for (const key of ["name", "version", "backend"]) {
      if (typeof value.processor[key] !== "string") issues.push(`processor.${key} must be a string`);
    }
  }
  return { valid: issues.length === 0, issues };
}

function processingError({ type, url, detail, retryable }) {
  return {
    ok: false,
    error: {
      type,
      processor: "python-docproc",
      url: url || null,
      detail: detail || null,
      retryable: Boolean(retryable),
      timestamp: new Date().toISOString(),
    },
  };
}

async function processWithPython(rawDoc, options = {}) {
  if (!rawDoc || typeof rawDoc.url !== "string") {
    throw new Error("documentProcessing: raw document with url is required");
  }
  if (!Buffer.isBuffer(rawDoc.content)) {
    return processingError({
      type: "invalid-input",
      url: rawDoc.url,
      detail: "PDF raw document content must be a Buffer",
      retryable: false,
    });
  }
  const serviceUrl = serviceUrlOf(options);
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  const form = new FormData();
  form.append("file", new Blob([rawDoc.content], { type: "application/pdf" }), "document.pdf");
  form.append("content_type", "application/pdf");
  form.append("filename", "document.pdf");
  form.append("source_url", rawDoc.url);

  let response;
  try {
    response = await fetch(`${serviceUrl.replace(/\/$/, "")}/process`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error && (error.name === "TimeoutError" || /timeout|aborted/i.test(error.message || ""));
    return processingError({
      type: timedOut ? "timeout" : "connection-error",
      url: rawDoc.url,
      detail: (error && error.message) || String(error),
      retryable: true,
    });
  }

  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    return processingError({
      type: "invalid-response",
      url: rawDoc.url,
      detail: `service returned HTTP ${response.status} with an unreadable body`,
      retryable: response.status >= 500,
    });
  }

  if (response.status === 422 && body && body.error) {
    return processingError({
      type: `processor-${body.error.type || "error"}`,
      url: rawDoc.url,
      detail: body.error.detail || null,
      retryable: false,
    });
  }
  if (!response.ok) {
    return processingError({
      type: "http-error",
      url: rawDoc.url,
      detail: `service returned HTTP ${response.status}`,
      retryable: response.status >= 500,
    });
  }
  const check = validateRepresentation(body);
  if (!check.valid) {
    return processingError({
      type: "invalid-response",
      url: rawDoc.url,
      detail: `representation failed contract validation: ${check.issues.join("; ")}`,
      retryable: false,
    });
  }
  return { ok: true, representation: body };
}

async function processDocument(rawDoc, options = {}) {
  const decision = shouldUsePython(rawDoc, options.profile);
  if (!decision.usePython) {
    return { ok: true, handled: false, path: "node", reason: decision.reason };
  }
  return processWithPython(rawDoc, options);
}

module.exports = {
  DEFAULT_SERVICE_URL,
  DEFAULT_TIMEOUT_MS,
  PYTHON_PROFILE_TYPES,
  FORBIDDEN_EXAM_KEYS,
  shouldUsePython,
  validateRepresentation,
  processWithPython,
  processDocument,
};
