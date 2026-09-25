#!/usr/bin/env node
// =============================================================================
// scraper/cli/allowlist.js — STEP 24 operator allowlist resolution CLI
// =============================================================================
// WHAT: Operator entry point for resolving Step 23 allowlist freshness
//   reviews, one review at a time:
//     node scraper/cli/allowlist.js inspect --review <reviewKey> [--mongo-uri <uri>]
//     node scraper/cli/allowlist.js resolve --review <reviewKey> --url <oldUrl>
//       --update <verifiedUrl> --adapter <slug> --operator <name>
//       --reason "..." --evidence-source "..." --evidence-verification "..."
//       [--mongo-uri <uri>]
//     node scraper/cli/allowlist.js resolve --review <reviewKey> --url <oldUrl>
//       --retire --adapter <slug> --operator <name>
//       --reason "..." --evidence-source "..." --evidence-verification "..."
//       [--mongo-uri <uri>]
//   inspect is read-only. resolve UPDATE probes the exact new URL through the
//   render-aware transport and persists only on document acceptance; resolve
//   RETIRE marks the declaration inactive while preserving all history.
// WHY: Detection is automatic; remediation is human. Every decision carries
//   operator + reason + evidence, is validated before persisting, and lands
//   in an append-only audit trail. There is no auto-discovery, no redirect
//   adoption, no publishing path anywhere in this file.
// CONNECTION: --mongo-uri flag wins, else SCRAPER_MONGO_URI, else MONGO_URI
//   (project convention). Only staging collections are ever opened.
// EXIT CODES: 0 inspected/resolved (including idempotent already-resolved) ·
//   1 usage/validation/resolution failure.
// =============================================================================

const { getExamCandidateModel } = require("../models/examCandidate");
const { getSurveillanceStateModel } = require("../models/surveillanceState");
const { getReviewStateModel } = require("../models/reviewState");
const { getAllowlistDeclarationModel } = require("../models/allowlistDeclaration");
const {
  inspectFreshnessReview,
  resolveUpdate,
  resolveRetire,
} = require("../operations/allowlistResolution");

function usage() {
  return [
    "Usage:",
    "  node scraper/cli/allowlist.js inspect --review <reviewKey> [--mongo-uri <uri>]",
    "  node scraper/cli/allowlist.js resolve --review <reviewKey> --url <oldUrl> --update <verifiedUrl> --adapter <slug> --operator <name> --reason \"...\" --evidence-source \"...\" --evidence-verification \"...\" [--mongo-uri <uri>]",
    "  node scraper/cli/allowlist.js resolve --review <reviewKey> --url <oldUrl> --retire --adapter <slug> --operator <name> --reason \"...\" --evidence-source \"...\" --evidence-verification \"...\" [--mongo-uri <uri>]",
    "",
    "Options:",
    "  --review <key>            freshness review key, e.g. surveillance:<candidateId> (required)",
    "  --url <oldUrl>            declared URL under review (required with resolve)",
    "  --update <url>            explicitly verified replacement URL (never inferred)",
    "  --retire                  mark the declaration inactive instead of replacing it",
    "  --adapter <slug>          registry adapter slug owning the declaration (required with resolve)",
    "  --operator <name>         deciding operator (required with resolve)",
    "  --reason <text>           why this decision is correct (required with resolve)",
    "  --evidence-source <text>  where the evidence came from (required with resolve)",
    "  --evidence-verification <text>  how the evidence was verified (required with resolve)",
    "  --mongo-uri <uri>         MongoDB URI (else SCRAPER_MONGO_URI, else MONGO_URI)",
    "  --help                    show this help",
    "",
    "Resolutions are audited and never publish, accept, or modify exam data.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    command: null,
    review: null,
    url: null,
    update: null,
    retire: false,
    adapter: null,
    operator: null,
    reason: null,
    evidenceSource: null,
    evidenceVerification: null,
    mongoUri: null,
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--review" && i + 1 < argv.length) args.review = argv[(i += 1)];
    else if (token === "--url" && i + 1 < argv.length) args.url = argv[(i += 1)];
    else if (token === "--update" && i + 1 < argv.length) args.update = argv[(i += 1)];
    else if (token === "--retire") args.retire = true;
    else if (token === "--adapter" && i + 1 < argv.length) args.adapter = argv[(i += 1)];
    else if (token === "--operator" && i + 1 < argv.length) args.operator = argv[(i += 1)];
    else if (token === "--reason" && i + 1 < argv.length) args.reason = argv[(i += 1)];
    else if (token === "--evidence-source" && i + 1 < argv.length) args.evidenceSource = argv[(i += 1)];
    else if (token === "--evidence-verification" && i + 1 < argv.length) args.evidenceVerification = argv[(i += 1)];
    else if (token === "--mongo-uri" && i + 1 < argv.length) args.mongoUri = argv[(i += 1)];
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token.startsWith("--")) throw new Error(`unknown argument "${token}"\n\n${usage()}`);
    else positional.push(token);
  }
  if (positional.length > 1) throw new Error(`expected one command (inspect|resolve)\n\n${usage()}`);
  if (positional.length === 1) {
    if (!["inspect", "resolve"].includes(positional[0])) {
      throw new Error(`unknown command "${positional[0]}" (expected inspect|resolve)\n\n${usage()}`);
    }
    args.command = positional[0];
  }
  if (!args.help) {
    if (!args.command) throw new Error(`a command is required\n\n${usage()}`);
    if (!args.review) throw new Error(`--review <reviewKey> is required\n\n${usage()}`);
    if (args.command === "resolve") {
      if (!args.url) throw new Error(`--url <oldUrl> is required\n\n${usage()}`);
      if ((args.update ? 1 : 0) + (args.retire ? 1 : 0) !== 1) {
        throw new Error(`pass exactly one of --update <url> or --retire\n\n${usage()}`);
      }
      if (!args.adapter) throw new Error(`--adapter <slug> is required\n\n${usage()}`);
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

async function connect(mongoUri) {
  const mongoose = require("mongoose");
  return mongoose.createConnection(mongoUri).asPromise();
}

function wireModels(connection) {
  return {
    ExamCandidate: getExamCandidateModel(connection),
    SurveillanceState: getSurveillanceStateModel(connection),
    ReviewState: getReviewStateModel(connection),
    AllowlistDeclaration: getAllowlistDeclarationModel(connection),
  };
}

async function runInspectCommand(models, reviewKey) {
  const { review, items } = await inspectFreshnessReview(models, reviewKey);
  console.log(`review: ${reviewKey}  stage: ${review.stage}  items: ${items.length}`);
  for (const { item, observation, baseline } of items) {
    console.log(`  field: ${item.field}  status: ${item.reviewStatus}`);
    console.log(`    reason: ${item.reason}`);
    if (observation) {
      console.log(
        `    observed: reachable=${observation.reachable} accepted=${observation.accepted} ` +
          `hash=${observation.contentHash || "none"} bytes=${observation.byteLength === null || observation.byteLength === undefined ? "unknown" : observation.byteLength}`
      );
    } else {
      console.log("    observed: none recorded");
    }
    if (baseline) {
      console.log(`    baseline hash: ${baseline.contentHash || "none"}`);
    }
  }
  console.log(JSON.stringify({ reviewKey, items: items.map((entry) => entry.item) }, null, 2));
  return 0;
}

async function runResolveCommand(models, args) {
  const adapter = loadAdapterBySlug(args.adapter);
  const evidence = { source: args.evidenceSource, verification: args.evidenceVerification };
  const common = {
    models,
    reviewKey: args.review,
    url: args.url,
    operator: args.operator,
    reason: args.reason,
    evidence,
    adapter,
  };
  const outcome = args.update
    ? await resolveUpdate({ ...common, newUrl: args.update })
    : await resolveRetire(common);
  if (!outcome.resolved) {
    console.log(`NO-OP — ${outcome.reason}.`);
    console.log(JSON.stringify(outcome.existing, null, 2));
    return 0;
  }
  const audit = outcome.audit;
  console.log(`${audit.decision}D — ${audit.oldUrl}${audit.newUrl ? ` → ${audit.newUrl}` : " (retired)"} by ${audit.operator}.`);
  console.log(JSON.stringify({ audit, declaration: outcome.declaration }, null, 2));
  return 0;
}

async function main(argv, env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const mongoUri = resolveMongoUri(args.mongoUri, env);
  const connection = await connect(mongoUri);
  try {
    const models = wireModels(connection);
    if (args.command === "inspect") return runInspectCommand(models, args.review);
    return runResolveCommand(models, args);
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`allowlist CLI failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { main, parseArgs, resolveMongoUri, usage };
