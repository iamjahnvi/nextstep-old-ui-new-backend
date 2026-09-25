#!/usr/bin/env node
// =============================================================================
// scraper/cli/ingestBatch.js — STEP 11 batch dry-run ingestion (capped)
// =============================================================================
// WHAT: Operator entry point for a BOUNDED, dry-run-only batch:
//     node scraper/cli/ingestBatch.js --candidate <id1> --candidate <id2> --dry-run
//     node scraper/cli/ingestBatch.js --status DISCOVERED --limit 5 --dry-run
//   Exactly one adapter ingests every selected candidate through the Step 9
//   runner, sequentially. Prints per-candidate terminal states plus the final
//   summary. No --confirm exists and is refused loudly if passed: batches
//   never publish.
// WHY: Controlled multi-exam ingestion with explicit selection and an explicit
//   cap. Empty selections, unknown IDs, and over-cap requests fail fast with
//   usage errors instead of guessing.
// CONNECTION: --mongo-uri flag wins, else SCRAPER_MONGO_URI, else MONGO_URI
//   (project convention). Only staging collections are ever opened.
// EXIT CODES: 0 batch completed (individual candidate failures do not fail
//   the command — they are reported per candidate) · 1 usage/selection/run
//   failure.
// =============================================================================

const { runBatchIngestion, DEFAULT_MAX_CANDIDATES } = require("../pipeline/batchIngestion");
const { getExamCandidateModel } = require("../models/examCandidate");
const { getSourceProfileModel } = require("../models/sourceProfile");
const { getRawDocumentModel } = require("../models/rawDocument");
const { getExamEditionDraftModel } = require("../models/examEditionDraft");
const { getReviewStateModel } = require("../models/reviewState");

function usage() {
  return [
    "Usage:",
    "  node scraper/cli/ingestBatch.js --candidate <id1> [--candidate <id2> ...] --adapter <slug> --dry-run [--max-candidates <n>]",
    "  node scraper/cli/ingestBatch.js --status DISCOVERED [--limit <n>] --adapter <slug> --dry-run [--max-candidates <n>]",
    "",
    "Options:",
    "  --candidate <id>    exam-candidate ID to ingest (repeatable, exactly the IDs given)",
    "  --status <s>        select by status (only DISCOVERED is supported; not combinable with --candidate)",
    "  --limit <n>         cap status selection (default: max-candidates)",
    "  --max-candidates <n> hard cap on batch size (default 5)",
    "  --adapter <slug>    registry adapter slug applied to every candidate (required)",
    "  --dry-run           staging-only dry run (required; the only mode)",
    "  --year <n>          edition year override (optional)",
    "  --cycle <s>         edition cycle override (optional)",
    "  --mongo-uri <uri>   MongoDB URI (else SCRAPER_MONGO_URI, else MONGO_URI)",
    "  --help              show this help",
    "",
    "There is no --confirm flag: batches never publish.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    candidateIds: [], status: null, limit: undefined, maxCandidates: undefined,
    adapter: null, dryRun: false, year: undefined, cycle: undefined, mongoUri: null, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--candidate" && i + 1 < argv.length) args.candidateIds.push(argv[(i += 1)]);
    else if (token === "--status" && i + 1 < argv.length) args.status = argv[(i += 1)];
    else if (token === "--limit" && i + 1 < argv.length) args.limit = Number(argv[(i += 1)]);
    else if (token === "--max-candidates" && i + 1 < argv.length) args.maxCandidates = Number(argv[(i += 1)]);
    else if (token === "--adapter" && i + 1 < argv.length) args.adapter = argv[(i += 1)];
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--year" && i + 1 < argv.length) args.year = Number(argv[(i += 1)]);
    else if (token === "--cycle" && i + 1 < argv.length) args.cycle = argv[(i += 1)];
    else if (token === "--mongo-uri" && i + 1 < argv.length) args.mongoUri = argv[(i += 1)];
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--confirm") throw new Error("--confirm is not supported: batches never publish");
    else throw new Error(`unknown argument "${token}"\n\n${usage()}`);
  }
  if (!args.help) {
    if (args.candidateIds.length > 0 && args.status) {
      throw new Error(`--candidate and --status cannot be combined\n\n${usage()}`);
    }
    if (args.status && args.status !== "DISCOVERED") {
      throw new Error(`only --status DISCOVERED selection is supported\n\n${usage()}`);
    }
    if (args.candidateIds.length === 0 && !args.status) {
      throw new Error(`empty candidate selection (pass --candidate IDs or --status DISCOVERED)\n\n${usage()}`);
    }
    if (!args.adapter) throw new Error(`--adapter <slug> is required\n\n${usage()}`);
    if (!args.dryRun) throw new Error(`--dry-run is required (batches run dry-run only)\n\n${usage()}`);
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

function loadAdapterBySlug(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`unknown adapter "${slug}" (expected a lowercase registry slug, see registry/exams/)`);
  }
  try {
    return require(`../registry/exams/${slug}.js`);
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") {
      throw new Error(`unknown adapter "${slug}" (no registry/exams/${slug}.js)`);
    }
    throw error;
  }
}

function printSummary(summary) {
  console.log("BATCH INGEST DRY RUN — staging only; nothing published, no production writes.");
  for (const result of summary.results) {
    const extra = result.draftId ? ` draft:${result.draftId}` : result.error ? ` error:${result.error.slice(0, 120)}` : "";
    console.log(`  ${result.status}  ${result.candidateId}${extra}`);
  }
  console.log(
    `summary: total=${summary.total} completed=${summary.completed} reviewRequired=${summary.reviewRequired} ` +
      `skipped=${summary.skipped} failed=${summary.failed} drafts=${summary.drafts.length}`
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
  const adapter = loadAdapterBySlug(args.adapter);
  const mongoose = require("mongoose");
  const connection = await mongoose.createConnection(mongoUri).asPromise();
  try {
    const deps = {
      ExamCandidate: getExamCandidateModel(connection),
      SourceProfile: getSourceProfileModel(connection),
      RawDocument: getRawDocumentModel(connection),
      EditionDraft: getExamEditionDraftModel(connection),
      ReviewState: getReviewStateModel(connection),
      adapter,
    };
    // Fail fast on unknown IDs before spending a run: every --candidate ID
    // must exist in staging.
    for (const id of args.candidateIds) {
      const found = await deps.ExamCandidate.findOne({ candidateId: id }).lean();
      if (!found) throw new Error(`unknown candidate ID "${id}" (no such candidate in staging)`);
    }
    const selection = args.candidateIds.length > 0
      ? { candidateIds: args.candidateIds }
      : { status: args.status, limit: args.limit };
    const summary = await runBatchIngestion(selection, deps, {
      maxCandidates: args.maxCandidates,
      year: args.year,
      cycle: args.cycle,
      dryRun: true,
    });
    printSummary(summary);
    return 0;
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`ingestBatch CLI failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { main, parseArgs, resolveMongoUri, usage, DEFAULT_MAX_CANDIDATES };
