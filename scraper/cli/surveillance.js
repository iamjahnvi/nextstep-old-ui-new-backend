#!/usr/bin/env node
// =============================================================================
// scraper/cli/surveillance.js — STEP 12 surveillance CLI (dry-run default)
// =============================================================================
// WHAT: Manual surveillance trigger for exact candidates:
//     node scraper/cli/surveillance.js --candidate <id> [--candidate <id2>] [--dry-run]
//     node scraper/cli/surveillance.js --limit 5 [--dry-run] [--persist]
//   Prints per-candidate outcomes (NO_ACTION / REVIEW_REQUIRED / FAILED),
//   drift triggers, and review-state keys. Dry-run is the default AND the
//   required posture: without --persist nothing is written anywhere — not
//   even staging. --persist records state/history/review in staging only.
//   There is no publishing flag, no auto-update flag, and no auto-accept flag.
// WHY: Operators re-check sources on demand today; a real scheduler later
//   invokes this same entry point. Unknown IDs are reported as FAILED
//   entries; empty selections and over-cap requests fail fast.
// CONNECTION: --mongo-uri flag wins, else SCRAPER_MONGO_URI, else MONGO_URI
//   (project convention). Only staging collections are ever opened.
// EXIT CODES: 0 checks completed (per-candidate FAILED does not fail the
//   command) · 1 usage/selection/run failure.
// =============================================================================

const { runSurveillanceChecks, DEFAULT_MAX_CANDIDATES } = require("../surveillance/sourceSurveillance");
const { getExamCandidateModel } = require("../models/examCandidate");
const { getSurveillanceStateModel } = require("../models/surveillanceState");
const { getReviewStateModel } = require("../models/reviewState");

function usage() {
  return [
    "Usage:",
    "  node scraper/cli/surveillance.js --candidate <id> [--candidate <id2> ...] [--dry-run] [--persist]",
    "  node scraper/cli/surveillance.js --limit <n> [--dry-run] [--persist]",
    "",
    "Options:",
    "  --candidate <id>    candidate ID to check (repeatable, exactly the IDs given)",
    "  --limit <n>         check up to N oldest candidates (bounded; not combinable with --candidate)",
    "  --max-candidates <n> hard cap on checks (default 5)",
    "  --dry-run           check without writing anything (default; required posture)",
    "  --persist           record state, history, and review triggers in staging (else nothing is written)",
    "  --mongo-uri <uri>   MongoDB URI (else SCRAPER_MONGO_URI, else MONGO_URI)",
    "  --help              show this help",
    "",
    "There is no publishing, auto-update, or auto-accept flag.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    candidateIds: [], limit: undefined, maxCandidates: undefined,
    dryRun: true, explicitDryRun: false, persist: false, mongoUri: null, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--candidate" && i + 1 < argv.length) args.candidateIds.push(argv[(i += 1)]);
    else if (token === "--limit" && i + 1 < argv.length) args.limit = Number(argv[(i += 1)]);
    else if (token === "--max-candidates" && i + 1 < argv.length) args.maxCandidates = Number(argv[(i += 1)]);
    else if (token === "--dry-run") { args.dryRun = true; args.explicitDryRun = true; }
    else if (token === "--persist") args.persist = true;
    else if (token === "--mongo-uri" && i + 1 < argv.length) args.mongoUri = argv[(i += 1)];
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--confirm" || token === "--publish" || token === "--accept") {
      throw new Error(`${token} is not supported: surveillance never publishes, updates, or accepts`);
    } else throw new Error(`unknown argument "${token}"\n\n${usage()}`);
  }
  if (!args.help) {
    if (args.candidateIds.length > 0 && args.limit !== undefined) {
      throw new Error(`--candidate and --limit cannot be combined\n\n${usage()}`);
    }
    if (args.candidateIds.length === 0 && args.limit === undefined) {
      throw new Error(`empty candidate selection (pass --candidate IDs or --limit)\n\n${usage()}`);
    }
    for (const id of args.candidateIds) {
      if (typeof id !== "string" || !id.trim()) {
        throw new Error(`invalid candidate ID in selection\n\n${usage()}`);
      }
    }
    if (args.limit !== undefined && !(Number.isInteger(args.limit) && args.limit >= 1)) {
      throw new Error(`--limit must be a positive integer\n\n${usage()}`);
    }
    if (args.maxCandidates !== undefined && !(Number.isInteger(args.maxCandidates) && args.maxCandidates >= 1)) {
      throw new Error(`--max-candidates must be a positive integer\n\n${usage()}`);
    }
    // Dry-run is the default posture: an explicit --dry-run always wins over
    // --persist, so recording requires --persist WITHOUT --dry-run.
    args.persist = args.persist === true && args.explicitDryRun !== true;
    args.dryRun = !args.persist;
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

function printSummary(summary, persisted) {
  console.log(
    persisted
      ? "SURVEILLANCE — staging state recorded; no exam data modified, nothing published."
      : "SURVEILLANCE DRY RUN — no writes performed anywhere."
  );
  for (const result of summary.results) {
    const triggers = result.driftTriggers.length > 0 ? ` triggers:${result.driftTriggers.join(",")}` : "";
    const review = result.reviewStateKey ? ` review:${result.reviewStateKey}` : "";
    const error = result.error ? ` error:${String(result.error).slice(0, 120)}` : "";
    const baseline = result.baselineEstablished ? " baseline-established" : "";
    console.log(`  ${result.driftStatus}  ${result.candidateId}${triggers}${review}${error}${baseline}`);
  }
  console.log(
    `summary: total=${summary.total} noAction=${summary.noAction} ` +
      `reviewRequired=${summary.reviewRequired} failed=${summary.failed}`
  );
  console.log(JSON.stringify(summary, null, 2));
}

async function main(argv, env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const mongoUri = resolveMongoUri(args.mongoUri, env);
  const mongoose = require("mongoose");
  const connection = await mongoose.createConnection(mongoUri).asPromise();
  try {
    const deps = {
      ExamCandidate: getExamCandidateModel(connection),
      SurveillanceState: getSurveillanceStateModel(connection),
      ReviewState: getReviewStateModel(connection),
    };
    for (const id of args.candidateIds) {
      const found = await deps.ExamCandidate.findOne({ candidateId: id }).lean();
      if (!found) throw new Error(`unknown candidate ID "${id}" (no such candidate in staging)`);
    }
    const selection = args.candidateIds.length > 0
      ? { candidateIds: args.candidateIds }
      : { limit: args.limit };
    const summary = await runSurveillanceChecks(selection, deps, {
      maxCandidates: args.maxCandidates,
      persist: args.persist,
    });
    printSummary(summary, args.persist);
    return 0;
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`surveillance CLI failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { main, parseArgs, resolveMongoUri, usage, DEFAULT_MAX_CANDIDATES };
