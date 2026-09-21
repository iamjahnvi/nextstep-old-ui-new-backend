#!/usr/bin/env node
// =============================================================================
// scraper/cli/publish.js
// =============================================================================
// WHAT: Operator CLI for the manual production publish workflow:
//     1. inspect a VERIFIED draft      (dry-run shows the mapped payload)
//     2. run a DRY RUN                  (default — writes nothing)
//     3. review the resulting payload   (printed to stdout)
//     4. explicitly confirm publishing  (--confirm)
//     5. execute the production publish (single idempotent upsert)
//     6. display the publish receipt    (printed to stdout)
//   plus operator adjudication of UNKNOWN-with-evidence axes:
//     --adjudicate <draftId> --axis <axis> --decision <decision>
//       [--value <canonical>] --by <operator> [--note <note>]
// WHY: Operators get one obvious entry point with a safe default. All real
//   work delegates to the Phase 8 executor (publish/publishExecutor.js) and
//   the Phase 13 adjudicator (reviewPipeline.adjudicateDraft) — NO mapping,
//   validation, publishing, or adjudication logic is duplicated here.
// USAGE:
//   node scraper/cli/publish.js --draft <draftId>              (dry-run)
//   node scraper/cli/publish.js --draft <draftId> --dry-run    (dry-run)
//   node scraper/cli/publish.js --draft <draftId> --confirm [--by <operator>]
//   node scraper/cli/publish.js --adjudicate <draftId> --axis education --decision CONFIRM_VALUE --value "Graduate" --by <operator> [--note <note>]
//   node scraper/cli/publish.js --adjudicate <draftId> --axis education --decision KEEP_UNKNOWN --by <operator> [--note <note>]
// CONNECTION: --mongo-uri flag wins, else SCRAPER_MONGO_URI, else MONGO_URI
//   (project convention, see server/config/db.js). Nothing is hardcoded.
//   The staging draft/receipt models and the real production Exam model share
//   this one connection; the executor's collection guards still apply.
// EXIT CODES: 0 success · 1 usage/validation/publish failure.
// =============================================================================

const path = require("path");

const {
  dryRunPublish,
  publishVerifiedDraft,
} = require("../publish/publishExecutor");
const { adjudicateDraft, getDraft } = require("../pipeline/reviewPipeline");
const { runDriftReport } = require("../pipeline/driftReport");
const { getExamEditionDraftModel } = require("../models/examEditionDraft");
const { getPublishReceiptModel } = require("../models/publishReceipt");

function usage() {
  return [
    "Usage:",
    "  node scraper/cli/publish.js --draft <draftId>               dry-run (default, writes nothing)",
    "  node scraper/cli/publish.js --draft <draftId> --dry-run     dry-run (explicit)",
    "  node scraper/cli/publish.js --draft <draftId> --confirm [--by <operator>]",
    "  node scraper/cli/publish.js --adjudicate <draftId> --axis <axis> --decision <CONFIRM_VALUE|KEEP_UNKNOWN> [--value <canonical>] --by <operator> [--note <note>]",
    "  node scraper/cli/publish.js --drift-report <adapterSlug> [--mongo-uri <uri>]",
    "",
    "Options:",
    "  --draft <id>        staging draft _id to publish (required)",
    "  --dry-run           describe the publish without writing (default)",
    "  --confirm           execute the production publish (explicit gate)",
    "  --adjudicate <id>   staging draft _id to adjudicate (never publishes; not combinable with --draft/--dry-run/--confirm)",
    "  --adjudications <id> show a draft's adjudication history (read-only; not combinable with other modes)",
    "  --axis <axis>       eligibility axis to adjudicate (required with --adjudicate)",
    "  --decision <d>      CONFIRM_VALUE or KEEP_UNKNOWN (required with --adjudicate)",
    "  --value <v>         canonical value (required for CONFIRM_VALUE, forbidden for KEEP_UNKNOWN)",
    "  --note <note>       operator note recorded with the adjudication",
    "  --drift-report <s>  re-crawl adapter <s> and print NEW|UNCHANGED|CHANGED (monitoring only; not combinable with other modes)",
    "  --by <operator>     operator name recorded on the receipt / adjudication",
    "  --mongo-uri <uri>   MongoDB URI (else SCRAPER_MONGO_URI, else MONGO_URI)",
    "  --help              show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    draftId: null,
    dryRun: false,
    confirm: false,
    by: null,
    mongoUri: null,
    help: false,
    adjudicateId: null,
    showAdjudications: null,
    axis: null,
    decision: null,
    value: null,
    note: null,
    driftReport: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--draft" && i + 1 < argv.length) {
      args.draftId = argv[(i += 1)];
    } else if (token === "--dry-run") {
      args.dryRun = true;
    } else if (token === "--confirm") {
      args.confirm = true;
    } else if (token === "--by" && i + 1 < argv.length) {
      args.by = argv[(i += 1)];
    } else if (token === "--mongo-uri" && i + 1 < argv.length) {
      args.mongoUri = argv[(i += 1)];
    } else if (token === "--adjudicate" && i + 1 < argv.length) {
      args.adjudicateId = argv[(i += 1)];
    } else if (token === "--adjudications" && i + 1 < argv.length) {
      args.showAdjudications = argv[(i += 1)];
    } else if (token === "--axis" && i + 1 < argv.length) {
      args.axis = argv[(i += 1)];
    } else if (token === "--decision" && i + 1 < argv.length) {
      args.decision = argv[(i += 1)];
    } else if (token === "--value" && i + 1 < argv.length) {
      args.value = argv[(i += 1)];
    } else if (token === "--note" && i + 1 < argv.length) {
      args.note = argv[(i += 1)];
    } else if (token === "--drift-report" && i + 1 < argv.length) {
      args.driftReport = argv[(i += 1)];
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument "${token}"\n\n${usage()}`);
    }
  }
  return args;
}

function resolveMongoUri(flagUri, env = process.env) {
  const uri = flagUri || env.SCRAPER_MONGO_URI || env.MONGO_URI;
  if (!uri) {
    throw new Error(
      "no MongoDB URI — pass --mongo-uri or set SCRAPER_MONGO_URI / MONGO_URI"
    );
  }
  return uri;
}

function printResult(result) {
  if (result.dryRun) {
    console.log("DRY RUN — no database write occurred.");
  } else if (result.action === "created") {
    console.log("PUBLISHED — one production Exam record created.");
  } else {
    console.log("ALREADY PUBLISHED — no duplicate created, no write performed.");
  }
  console.log(
    `draft: ${result.draftId}  identity: ${result.identity}  action: ${result.action}`
  );
  if (result.examId) console.log(`production exam _id: ${result.examId}`);
  console.log(JSON.stringify(result, null, 2));
}

function printAdjudication(updated, args) {
  // Thin display only: the decision record carries the audit; the axis state
  // is read generically by key. No adjudication semantics live here.
  const plain =
    updated && typeof updated.toObject === "function"
      ? updated.toObject()
      : updated;
  const axisState =
    (plain.edition &&
      plain.edition.eligibility &&
      plain.edition.eligibility[args.axis]) ||
    {};
  const record =
    (plain.adjudications && plain.adjudications[plain.adjudications.length - 1]) ||
    {};
  console.log("ADJUDICATED — draft status unchanged; no production publish occurred.");
  console.log(`draft: ${plain._id}`);
  console.log(`axis: ${args.axis}`);
  console.log(`decision: ${record.decision}`);
  console.log(
    `value: ${record.value === null || record.value === undefined ? "null" : record.value}  axis status: ${axisState.status || "unknown"}`
  );
  console.log(
    `decidedBy: ${record.decidedBy}  decidedAt: ${record.decidedAt instanceof Date ? record.decidedAt.toISOString() : record.decidedAt}`
  );
  if (record.note) console.log(`note: ${record.note}`);
  console.log(JSON.stringify({ adjudication: record }, null, 2));
}

function printDriftReport(report) {
  // Thin display only: counts + per-document statuses. No drift semantics
  // live here.
  console.log(
    "DRIFT REPORT — monitoring only; no extraction, review, or publish occurred."
  );
  console.log(
    `adapter: ${report.adapter}  checked: ${report.checked}  ` +
      `NEW: ${report.new}  UNCHANGED: ${report.unchanged}  CHANGED: ${report.changed}`
  );
  for (const item of report.items) {
    console.log(`  ${item.status}  ${item.url}`);
  }
  console.log(JSON.stringify(report, null, 2));
}

// Resolve an adapter by slug using the registry file convention. Generic:
// no exam list is hardcoded; unknown slugs fail with a clear error and the
// adapter schema itself validates the loaded config downstream.
function loadAdapterBySlug(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(
      `unknown adapter "${slug}" (expected a lowercase registry slug, see registry/exams/)`
    );
  }
  let adapter;
  try {
    adapter = require(`../registry/exams/${slug}.js`);
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") {
      throw new Error(`unknown adapter "${slug}" (no registry/exams/${slug}.js)`);
    }
    throw error;
  }
  return adapter;
}

function printAdjudicationHistory(draft) {
  // Thin display only: reads the stored audit records in chronological
  // order. No adjudication semantics live here; records contain no evidence
  // payloads, only the decision audit.
  const plain =
    draft && typeof draft.toObject === "function" ? draft.toObject() : draft;
  const records = [...(plain.adjudications || [])].sort(
    (a, b) => new Date(a.decidedAt) - new Date(b.decidedAt)
  );
  console.log(`draft: ${plain._id}  status: ${plain.status}`);
  if (records.length === 0) {
    console.log("No adjudications recorded for this draft.");
    return;
  }
  for (const record of records) {
    const decidedAt =
      record.decidedAt instanceof Date
        ? record.decidedAt.toISOString()
        : record.decidedAt;
    console.log(
      `axis: ${record.axis}  decision: ${record.decision}  ` +
        `value: ${record.value === null || record.value === undefined ? "null" : JSON.stringify(record.value)}`
    );
    console.log(`decidedBy: ${record.decidedBy}  decidedAt: ${decidedAt}`);
    if (record.note) console.log(`note: ${record.note}`);
  }
  console.log(JSON.stringify({ adjudications: records }, null, 2));
}

async function runShowAdjudications(draftId, mongoUri) {
  // Read-only by construction: getDraft performs a single findById, and this
  // path never loads the production Exam model.
  const mongoose = require("mongoose");
  await mongoose.connect(mongoUri);
  try {
    const EditionDraft = getExamEditionDraftModel(mongoose.connection);
    const draft = await getDraft(EditionDraft, draftId);
    if (!draft) {
      throw new Error(`draft not found: ${draftId}`);
    }
    printAdjudicationHistory(draft);
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

async function runAdjudication(args, mongoUri) {
  // Presence checks only — axis/decision/value semantics, canonical
  // normalization, and draft-state rules all live in adjudicateDraft().
  if (!args.axis) {
    throw new Error(`--axis is required with --adjudicate\n\n${usage()}`);
  }
  if (!args.decision) {
    throw new Error(
      `--decision CONFIRM_VALUE|KEEP_UNKNOWN is required with --adjudicate\n\n${usage()}`
    );
  }
  if (!args.by) {
    throw new Error(`--by <operator> is required with --adjudicate\n\n${usage()}`);
  }
  // Adjudication never publishes, so only the staging model is wired here —
  // the production Exam model is deliberately not loaded on this path.
  const mongoose = require("mongoose");
  await mongoose.connect(mongoUri);
  try {
    const EditionDraft = getExamEditionDraftModel(mongoose.connection);
    const updated = await adjudicateDraft(EditionDraft, args.adjudicateId, {
      axis: args.axis,
      decision: args.decision,
      value: args.value,
      decidedBy: args.by,
      note: args.note,
    });
    printAdjudication(updated, args);
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

async function main(argv, env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.adjudicateId) {
    if (args.draftId || args.dryRun || args.confirm || args.driftReport || args.showAdjudications) {
      throw new Error(
        "--adjudicate cannot be combined with --draft/--dry-run/--confirm/--drift-report/--adjudications"
      );
    }
    const mongoUri = resolveMongoUri(args.mongoUri, env);
    return runAdjudication(args, mongoUri);
  }
  if (args.showAdjudications) {
    if (args.draftId || args.dryRun || args.confirm || args.driftReport || args.adjudicateId) {
      throw new Error(
        "--adjudications cannot be combined with --draft/--dry-run/--confirm/--drift-report/--adjudicate"
      );
    }
    const mongoUri = resolveMongoUri(args.mongoUri, env);
    return runShowAdjudications(args.showAdjudications, mongoUri);
  }
  if (args.driftReport) {
    if (args.draftId || args.dryRun || args.confirm || args.showAdjudications) {
      throw new Error(
        "--drift-report cannot be combined with --draft/--dry-run/--confirm/--adjudications"
      );
    }
    const mongoUri = resolveMongoUri(args.mongoUri, env);
    // Drift reporting never publishes, so only staging is wired here —
    // the production Exam model is deliberately not loaded on this path.
    const report = await runDriftReport(loadAdapterBySlug(args.driftReport), {
      mongoUri,
    });
    printDriftReport(report);
    return 0;
  }
  if (!args.draftId) {
    throw new Error(`--draft <draftId> is required\n\n${usage()}`);
  }
  if (args.dryRun && args.confirm) {
    throw new Error("pass either --dry-run or --confirm, not both");
  }

  const mongoUri = resolveMongoUri(args.mongoUri, env);

  // Wire the REAL production Exam model on the SAME mongoose instance it was
  // registered on (server code may resolve a different mongoose copy than the
  // scraper's — Exam.db.base is always the right one).
  const Exam =
    require("../../server/models/Exam");
  const mongoose = (Exam.db && Exam.db.base) || require("mongoose");
  await mongoose.connect(mongoUri);
  try {
    const EditionDraft = getExamEditionDraftModel(mongoose.connection);
    const Receipt = getPublishReceiptModel(mongoose.connection);

    if (args.confirm) {
      const result = await publishVerifiedDraft(EditionDraft, {
        Receipt,
        ExamModel: Exam,
        draftId: args.draftId,
        confirmPublish: true,
        publishedBy: args.by,
      });
      printResult(result);
    } else {
      if (!args.dryRun) {
        console.log("No mode flag given — defaulting to dry-run.");
      }
      const result = await dryRunPublish(EditionDraft, {
        Receipt,
        draftId: args.draftId,
      });
      printResult(result);
    }
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`publish CLI failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = {
  main,
  parseArgs,
  resolveMongoUri,
  usage,
};
