#!/usr/bin/env node
// =============================================================================
// scraper/cli/ingest.js — STEP 9 single-candidate dry-run ingestion
// =============================================================================
// WHAT: Operator entry point for one end-to-end dry-run ingestion:
//     node scraper/cli/ingest.js --candidate <candidateId> --adapter <slug> --dry-run
//   Runs exactly one DISCOVERED candidate through verification, profiling,
//   document discovery, fetch, processing, extraction, validation, confidence,
//   review, and staging — then stops. Prints a per-stage summary.
// WHY: A manual, single-candidate, staging-only dry run with no batch mode,
//   no scheduling, and no publishing path whatsoever. --confirm does not
//   exist here and is refused loudly if passed.
// CONNECTION: --mongo-uri flag wins, else SCRAPER_MONGO_URI, else MONGO_URI
//   (project convention). Only staging collections are ever opened.
// EXIT CODES: 0 success (including review-required stops — the run itself
//   completed) · 1 usage/run failure.
// =============================================================================

const path = require("path");

const { runEndToEndIngestion } = require("../pipeline/endToEndIngestion");
const { getExamCandidateModel } = require("../models/examCandidate");
const { getSourceProfileModel } = require("../models/sourceProfile");
const { getRawDocumentModel } = require("../models/rawDocument");
const { getExamEditionDraftModel } = require("../models/examEditionDraft");
const { getReviewStateModel } = require("../models/reviewState");

function usage() {
  return [
    "Usage:",
    "  node scraper/cli/ingest.js --candidate <candidateId> --adapter <slug> --dry-run [--year <n>] [--cycle <s>] [--mongo-uri <uri>]",
    "",
    "Options:",
    "  --candidate <id>  exam-candidate _candidateId_ to ingest (required, exactly one)",
    "  --adapter <slug>  registry adapter slug for extraction (required)",
    "  --dry-run         staging-only dry run (required; the only mode)",
    "  --year <n>        edition year override (optional)",
    "  --cycle <s>       edition cycle override (optional)",
    "  --mongo-uri <uri> MongoDB URI (else SCRAPER_MONGO_URI, else MONGO_URI)",
    "  --help            show this help",
    "",
    "There is no --confirm flag: ingestion never publishes.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { candidateId: null, adapter: null, dryRun: false, year: undefined, cycle: undefined, mongoUri: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--candidate" && i + 1 < argv.length) args.candidateId = argv[(i += 1)];
    else if (token === "--adapter" && i + 1 < argv.length) args.adapter = argv[(i += 1)];
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--year" && i + 1 < argv.length) args.year = Number(argv[(i += 1)]);
    else if (token === "--cycle" && i + 1 < argv.length) args.cycle = argv[(i += 1)];
    else if (token === "--mongo-uri" && i + 1 < argv.length) args.mongoUri = argv[(i += 1)];
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--confirm") throw new Error("--confirm is not supported: ingest is dry-run only and never publishes");
    else throw new Error(`unknown argument "${token}"\n\n${usage()}`);
  }
  // Required-arg validation lives here so both the CLI entry and tests get
  // the same usage errors; main() re-checks defensively.
  if (!args.help) {
    if (!args.candidateId) throw new Error(`--candidate <candidateId> is required\n\n${usage()}`);
    if (!args.adapter) throw new Error(`--adapter <slug> is required\n\n${usage()}`);
    if (!args.dryRun) throw new Error(`--dry-run is required (ingest runs dry-run only)\n\n${usage()}`);
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

function printSummary(result) {
  console.log("INGEST DRY RUN — staging only; nothing published, no production writes.");
  console.log(`candidate: ${result.candidateId}  adapter: ${result.adapter}`);
  for (const [stage, info] of Object.entries(result.stages || {})) {
    const detail =
      stage === "discovery" && info.documents ? ` (${info.documents.length} documents)` :
      stage === "fetch" && info.fetched ? ` (${info.fetched.length} fetched, ${info.failed.length} failed)` :
      stage === "draft" && info.draftId ? ` (${info.draftId})` : "";
    console.log(`  ${stage}: ${info.status}${detail}`);
  }
  console.log(
    `gates: ${Object.entries(result.gates || {}).map(([gateName, state]) => `${gateName}=${state}`).join("  ")}`
  );
  console.log(`stoppedAt: ${result.stoppedAt.stage} — ${result.stoppedAt.reason}`);
  if (result.review) console.log(`review: ${result.review.stage}`);
  console.log(JSON.stringify(result, null, 2));
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
    const result = await runEndToEndIngestion(
      args.candidateId,
      {
        ExamCandidate: getExamCandidateModel(connection),
        SourceProfile: getSourceProfileModel(connection),
        RawDocument: getRawDocumentModel(connection),
        EditionDraft: getExamEditionDraftModel(connection),
        ReviewState: getReviewStateModel(connection),
        adapter,
      },
      { year: args.year, cycle: args.cycle, dryRun: true }
    );
    printSummary(result);
    return 0;
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`ingest CLI failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { main, parseArgs, resolveMongoUri, usage };
