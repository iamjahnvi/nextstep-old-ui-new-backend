#!/usr/bin/env node
// =============================================================================
// scraper/cli/operations.js — STEP 13 operations CLI (safe/read-only default)
// =============================================================================
// WHAT: Operator entry point for system operations:
//     node scraper/cli/operations.js health [--mongo-uri <uri>]
//     node scraper/cli/operations.js readiness [--mongo-uri <uri>]
//     node scraper/cli/operations.js status [--mongo-uri <uri>] [--limit <n>]
//     node scraper/cli/operations.js retention [--mongo-uri <uri>]
//   health/readiness probe dependencies and exit non-zero when the system
//   cannot operate; status lists recent operation runs; retention prints the
//   policy plus prunable counts (planning only — pruning itself requires the
//   retention module called with explicit confirm + actor, which no CLI flag
//   provides). There is no command here that publishes, accepts review items,
//   modifies exam data, or prunes anything.
// WHY: One obvious, safe place to ask "is the system OK, what happened
//   lately, what would retention do?" Every command is read-only by
//   construction; failures notify through the local log transport and exit 1.
// EXIT CODES: 0 ok (status/retention always exit 0 on success) · 1 usage,
//   health NOT_READY/DEGRADED? No — health exits 1 only on NOT_READY
//   (DEGRADED is operable); readiness exits 1 unless HEALTHY.
// =============================================================================

const { checkHealth } = require("../operations/health");
const { planRetention } = require("../operations/retention");
const { getOperationRunModel } = require("../models/operationRun");
const { getSurveillanceStateModel } = require("../models/surveillanceState");
const { getReviewStateModel } = require("../models/reviewState");
const { notify } = require("../operations/notifications");
const { createLogger } = require("../operations/logger");

function usage() {
  return [
    "Usage:",
    "  node scraper/cli/operations.js health [--mongo-uri <uri>]",
    "  node scraper/cli/operations.js readiness [--mongo-uri <uri>]",
    "  node scraper/cli/operations.js status [--mongo-uri <uri>] [--limit <n>]",
    "  node scraper/cli/operations.js retention [--mongo-uri <uri>]",
    "",
    "All commands are read-only. No command publishes, accepts, or deletes.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { command: null, limit: 10, mongoUri: null, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--mongo-uri" && i + 1 < argv.length) args.mongoUri = argv[(i += 1)];
    else if (token === "--limit" && i + 1 < argv.length) args.limit = Number(argv[(i += 1)]);
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token.startsWith("--")) throw new Error(`unknown argument "${token}"\n\n${usage()}`);
    else positional.push(token);
  }
  if (positional.length > 1) throw new Error(`expected one command (health|readiness|status|retention)\n\n${usage()}`);
  if (positional.length === 1) {
    if (!["health", "readiness", "status", "retention"].includes(positional[0])) {
      throw new Error(`unknown command "${positional[0]}" (expected health|readiness|status|retention)\n\n${usage()}`);
    }
    args.command = positional[0];
  }
  if (!args.help) {
    if (!args.command) throw new Error(`a command is required\n\n${usage()}`);
    if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error(`--limit must be a positive integer\n\n${usage()}`);
  }
  return args;
}

function resolveMongoUri(flagUri, env = process.env) {
  const uri = flagUri || env.SCRAPER_MONGO_URI || env.MONGO_URI;
  if (!uri) {
    throw new Error("no MongoDB URI — pass --mongo-uri or set SCRAPER_MONGO_URI / MONGO_URI");
  }
  return uri;
}

async function connect(mongoUri) {
  const mongoose = require("mongoose");
  return mongoose.createConnection(mongoUri).asPromise();
}

async function runHealthCommand(mongoUri, logger) {
  const connection = await connect(mongoUri);
  try {
    const report = await checkHealth({ connection, env: process.env, directories: ["scraper"] });
    console.log(`health: ${report.status}`);
    for (const check of report.checks) {
      console.log(`  ${check.status}  ${check.name} — ${check.reason}`);
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "NOT_READY") {
      await notify(
        { type: "READINESS_FAILED", severity: "critical", message: `health check NOT_READY: ${report.checks.filter((c) => c.status === "NOT_READY").map((c) => c.name).join(", ")}`, details: { report } },
        { logger }
      );
      return 1;
    }
    return 0;
  } finally {
    await connection.close();
  }
}

async function runReadinessCommand(mongoUri, logger) {
  const connection = await connect(mongoUri);
  try {
    const report = await checkHealth({ connection, env: process.env, directories: ["scraper"] });
    console.log(`readiness: ${report.status}`);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "HEALTHY") {
      await notify(
        { type: "READINESS_FAILED", severity: "critical", message: `system not ready: ${report.status}`, details: { report } },
        { logger }
      );
      return 1;
    }
    return 0;
  } finally {
    await connection.close();
  }
}

async function runStatusCommand(mongoUri, limit) {
  const connection = await connect(mongoUri);
  try {
    const OperationRun = getOperationRunModel(connection);
    const runs = await OperationRun.find({}).sort({ startedAt: -1 }).limit(limit).lean();
    if (runs.length === 0) {
      console.log("status: no operation runs recorded");
    }
    for (const run of runs) {
      console.log(
        `  ${run.status}  ${run.runType}  ${run.runId}  candidates=${run.candidateCount} ` +
          `ok=${run.successCount} failed=${run.failureCount} review=${run.reviewRequiredCount}`
      );
    }
    console.log(JSON.stringify({ runs }, null, 2));
    return 0;
  } finally {
    await connection.close();
  }
}

async function runRetentionCommand(mongoUri) {
  const connection = await connect(mongoUri);
  try {
    const plan = await planRetention({
      SurveillanceState: getSurveillanceStateModel(connection),
      ReviewState: getReviewStateModel(connection),
      OperationRun: getOperationRunModel(connection),
    });
    console.log("retention policy (planning only — pruning requires explicit confirm + actor, no CLI flag provides it):");
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  } finally {
    await connection.close();
  }
}

async function main(argv, env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const logger = createLogger({});
  const mongoUri = resolveMongoUri(args.mongoUri, env);
  if (args.command === "health") return runHealthCommand(mongoUri, logger);
  if (args.command === "readiness") return runReadinessCommand(mongoUri, logger);
  if (args.command === "status") return runStatusCommand(mongoUri, args.limit);
  return runRetentionCommand(mongoUri);
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`operations CLI failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { main, parseArgs, resolveMongoUri, usage };
