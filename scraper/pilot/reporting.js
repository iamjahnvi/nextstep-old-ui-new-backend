// =============================================================================
// scraper/pilot/reporting.js — STEP 15 pilot audit builders (pure, no I/O)
// =============================================================================
// WHAT: Small deterministic builders for the pilot accuracy audit: audit
//   records with per-field operator verdicts, explicit baseline-vs-pilot
//   metric comparison, gap classification, and publish sign-off derived from
//   verdicts. The runner (pilotRun.js) produces evidence; the OPERATOR writes
//   verdicts after inspecting real sources. Nothing here fetches, extracts,
//   publishes, or invents values.
// CONTRACTS:
//   newAuditRecord({ source, exam, runId }) -> audit skeleton.
//   recordField(audit, { field, value, status, evidence, verdict }) — verdict
//     in accepted|rejected|investigate|null (null = not yet reviewed).
//   compareMetric({ name, baseline, pilot, comparable, note }) ->
//     { ..., verdict: DIRECTLY COMPARABLE | NOT COMPARABLE | NEW OBSERVATION }.
//     Comparability is DECLARED by the caller, never inferred.
//   recordGap(audit, { kind, title, detail }) — kind in BUG | CONFIGURATION
//     ISSUE | SOURCE-SPECIFIC ISSUE | EXPECTED MANUAL REVIEW | OPERATIONAL ISSUE.
//   signOff(audit, requiredFields) -> { decision: "approved"|"withheld",
//     reasons[] } — approved only when every required field is accepted.
// GENERICITY: shapes only. No exam names, no thresholds.
// =============================================================================

const FIELD_VERDICTS = ["accepted", "rejected", "investigate"];
const COMPARABILITY = ["DIRECTLY COMPARABLE", "NOT COMPARABLE", "NEW OBSERVATION"];
const GAP_KINDS = [
  "BUG",
  "CONFIGURATION ISSUE",
  "SOURCE-SPECIFIC ISSUE",
  "EXPECTED MANUAL REVIEW",
  "OPERATIONAL ISSUE",
];
const SIGN_OFFS = ["approved", "withheld"];

function newAuditRecord({ source, exam, runId } = {}) {
  if (!source || !exam) {
    throw new Error("reporting: source and exam descriptors are required");
  }
  return {
    source,
    exam,
    runId: runId || null,
    fields: [],
    gaps: [],
    signOff: null,
  };
}

function recordField(audit, { field, value, status, evidence, verdict = null } = {}) {
  if (!audit || !Array.isArray(audit.fields)) {
    throw new Error("reporting: audit record is required");
  }
  if (typeof field !== "string" || !field) {
    throw new Error("reporting: field name is required");
  }
  if (verdict !== null && !FIELD_VERDICTS.includes(verdict)) {
    throw new Error(`reporting: verdict must be ${FIELD_VERDICTS.join("|")} or null`);
  }
  const entry = {
    field,
    value: value === undefined ? null : value,
    status: status || null,
    evidence: evidence === undefined ? null : evidence,
    verdict,
  };
  audit.fields.push(entry);
  return entry;
}

function compareMetric({ name, baseline, pilot, comparable, note } = {}) {
  if (typeof name !== "string" || !name) {
    throw new Error("reporting: metric name is required");
  }
  if (comparable !== true && comparable !== false && comparable !== "new") {
    throw new Error('reporting: comparable must be true, false, or "new"');
  }
  return {
    name,
    baseline: baseline === undefined ? null : baseline,
    pilot: pilot === undefined ? null : pilot,
    verdict: comparable === true ? "DIRECTLY COMPARABLE" : comparable === "new" ? "NEW OBSERVATION" : "NOT COMPARABLE",
    note: note || null,
  };
}

function recordGap(audit, { kind, title, detail } = {}) {
  if (!audit || !Array.isArray(audit.gaps)) {
    throw new Error("reporting: audit record is required");
  }
  if (!GAP_KINDS.includes(kind)) {
    throw new Error(`reporting: gap kind must be ${GAP_KINDS.join(" | ")}`);
  }
  if (typeof title !== "string" || !title) {
    throw new Error("reporting: gap title is required");
  }
  const gap = { kind, title, detail: detail || null };
  audit.gaps.push(gap);
  return gap;
}

function signOff(audit, requiredFields = []) {
  if (!audit || !Array.isArray(audit.fields)) {
    throw new Error("reporting: audit record is required");
  }
  const required = Array.isArray(requiredFields) ? requiredFields : [];
  const reasons = [];
  for (const field of required) {
    const entry = audit.fields.find((item) => item.field === field);
    if (!entry) {
      reasons.push(`${field}: not reviewed`);
    } else if (entry.verdict === "rejected") {
      reasons.push(`${field}: rejected by operator`);
    } else if (entry.verdict !== "accepted") {
      reasons.push(`${field}: not accepted (verdict: ${entry.verdict || "none"})`);
    }
  }
  const decision = reasons.length === 0 ? "approved" : "withheld";
  audit.signOff = { decision, reasons };
  return audit.signOff;
}

// STEP 17 addition: per-exam operational verdict from operator field
// verdicts (recordField verdicts: accepted | rejected | investigate | null).
//   PASS             — every reviewed field accepted, none merely investigated.
//   PASS_WITH_REVIEW — nothing rejected, but open investigate items remain.
//   FAIL             — any rejected field, or nothing reviewed at all.
// Pure tally only; it never approves publishing (see signOff for that gate).
const EXAM_VERDICTS = ["PASS", "PASS_WITH_REVIEW", "FAIL"];

function gradeExam(audit) {
  if (!audit || !Array.isArray(audit.fields)) {
    throw new Error("reporting: audit record is required");
  }
  const verdicts = audit.fields.map((item) => item.verdict || null);
  if (verdicts.length === 0) {
    return { verdict: "FAIL", reasons: ["no fields reviewed"] };
  }
  const rejected = audit.fields.filter((item) => item.verdict === "rejected").map((item) => item.field);
  const open = audit.fields.filter((item) => item.verdict !== "accepted").map((item) => `${item.field}: ${item.verdict || "unreviewed"}`);
  if (rejected.length > 0) {
    return { verdict: "FAIL", reasons: rejected.map((field) => `${field}: rejected by operator`) };
  }
  if (open.length > 0) {
    return { verdict: "PASS_WITH_REVIEW", reasons: open };
  }
  return { verdict: "PASS", reasons: [] };
}

// STEP 19 addition: expansion gate from per-source outcomes. Each source
// contributes { slug, verdict, stopTriggered, restriction? } where verdict is
// an EXAM_VERDICTS value and stopTriggered marks a breached safety gate.
//   BLOCKED                    — any stop gate breached (never overridden).
//   PASSED WITH RESTRICTIONS   — any FAIL, or any PASS_WITH_REVIEW; the
//                                restrictions list names each one explicitly.
//   PASSED                     — every source PASS, no stops, no restrictions.
// Pure tally only; expanding anything still requires an operator decision.
const EXPANSION_GATES = ["PASSED", "PASSED WITH RESTRICTIONS", "BLOCKED"];

function summarizeExpansion(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("reporting: at least one source outcome is required");
  }
  const restrictions = [];
  let blocked = null;
  for (const source of sources) {
    if (!source || typeof source.slug !== "string" || !source.slug) {
      throw new Error("reporting: each source outcome needs a slug");
    }
    if (!EXAM_VERDICTS.includes(source.verdict)) {
      throw new Error(`reporting: unknown verdict "${source.verdict}" for ${source.slug}`);
    }
    if (source.stopTriggered === true) {
      blocked = blocked || { decision: "BLOCKED", reasons: [] };
      blocked.reasons.push(`${source.slug}: safety gate breached`);
    } else if (source.verdict === "FAIL") {
      restrictions.push(`${source.slug}: FAIL — excluded pending ${source.restriction || "further work"}`);
    } else if (source.verdict === "PASS_WITH_REVIEW") {
      restrictions.push(`${source.slug}: PASS_WITH_REVIEW — open review items must clear before any publish`);
    }
  }
  if (blocked) {
    return { decision: "BLOCKED", reasons: blocked.reasons, restrictions };
  }
  if (restrictions.length > 0) {
    return { decision: "PASSED WITH RESTRICTIONS", reasons: [], restrictions };
  }
  return { decision: "PASSED", reasons: [], restrictions };
}

module.exports = {
  FIELD_VERDICTS,
  COMPARABILITY,
  GAP_KINDS,
  SIGN_OFFS,
  EXAM_VERDICTS,
  EXPANSION_GATES,
  newAuditRecord,
  recordField,
  compareMetric,
  recordGap,
  signOff,
  gradeExam,
  summarizeExpansion,
};
