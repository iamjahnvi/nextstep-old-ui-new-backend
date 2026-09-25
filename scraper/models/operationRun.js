// =============================================================================
// scraper/models/operationRun.js
// =============================================================================
// WHAT: Mongoose schema for operational run tracking — "what did an
//   operational run do?" One document per run: type, timing, outcome counts,
//   and a short error summary. Statuses: RUNNING | COMPLETED | FAILED |
//   PARTIAL. Counts only, never secrets, never document contents, never exam
//   payloads: errorSummary holds short messages (already redacted upstream).
// ISOLATION: documents live in the `scraper_operation_runs` collection —
//   separate from candidates, drafts, review states, and production `exams`.
//   Nothing here imports server code.
// WHY per-connection factory: same convention as the other staging models.
// Thin persistence helpers (beginOperationRun/finishOperationRun) live here
//   so callers share one status-transition rule: RUNNING may close to any
//   terminal state exactly once; terminal states never reopen.
// =============================================================================

const mongoose = require("mongoose");

const OPERATION_RUN_COLLECTION = "scraper_operation_runs";
const OPERATION_RUN_TYPES = ["surveillance", "ingestion", "health"];
const OPERATION_RUN_STATUSES = ["RUNNING", "COMPLETED", "FAILED", "PARTIAL"];

const operationRunSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, trim: true, unique: true },
    runType: { type: String, required: true, enum: OPERATION_RUN_TYPES },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    status: { type: String, required: true, enum: OPERATION_RUN_STATUSES, default: "RUNNING" },
    candidateCount: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    reviewRequiredCount: { type: Number, default: 0 },
    errorSummary: { type: [String], default: [] },
  },
  { timestamps: true }
);

operationRunSchema.index({ status: 1 });
operationRunSchema.index({ runType: 1 });

function getOperationRunModel(connection) {
  if (!connection || typeof connection.model !== "function") {
    throw new Error("getOperationRunModel: a mongoose connection is required");
  }
  return connection.model("ScraperOperationRun", operationRunSchema, OPERATION_RUN_COLLECTION);
}

async function beginOperationRun(OperationRun, { runId, runType, candidateCount = 0 } = {}) {
  if (!OperationRun || !OperationRun.collection) {
    throw new Error("operationRun: a run model is required");
  }
  if (typeof runId !== "string" || !runId) {
    throw new Error("operationRun: runId is required");
  }
  if (!OPERATION_RUN_TYPES.includes(runType)) {
    throw new Error(`operationRun: unknown runType "${runType}" (expected ${OPERATION_RUN_TYPES.join("|")})`);
  }
  return OperationRun.create({
    runId,
    runType,
    startedAt: new Date(),
    finishedAt: null,
    status: "RUNNING",
    candidateCount,
    successCount: 0,
    failureCount: 0,
    reviewRequiredCount: 0,
    errorSummary: [],
  });
}

async function finishOperationRun(OperationRun, runId, outcome = {}) {
  if (!OperationRun || !OperationRun.collection) {
    throw new Error("operationRun: a run model is required");
  }
  const record = await OperationRun.findOne({ runId });
  if (!record) throw new Error(`operationRun: unknown runId "${runId}"`);
  if (record.status !== "RUNNING") {
    throw new Error(`operationRun: run "${runId}" is already terminal (${record.status})`);
  }
  const status = outcome.status;
  if (!["COMPLETED", "FAILED", "PARTIAL"].includes(status)) {
    throw new Error(`operationRun: terminal status is required (got "${status}")`);
  }
  record.status = status;
  record.finishedAt = new Date();
  for (const key of ["candidateCount", "successCount", "failureCount", "reviewRequiredCount"]) {
    if (typeof outcome[key] === "number" && outcome[key] >= 0) record[key] = Math.floor(outcome[key]);
  }
  if (Array.isArray(outcome.errorSummary)) {
    record.errorSummary = outcome.errorSummary.filter((line) => typeof line === "string").slice(0, 20);
  }
  await record.save();
  return record;
}

module.exports = {
  OPERATION_RUN_COLLECTION,
  OPERATION_RUN_TYPES,
  OPERATION_RUN_STATUSES,
  operationRunSchema,
  getOperationRunModel,
  beginOperationRun,
  finishOperationRun,
};
