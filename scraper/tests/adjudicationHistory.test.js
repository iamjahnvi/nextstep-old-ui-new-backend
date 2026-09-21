// =============================================================================
// scraper/tests/adjudicationHistory.test.js
// =============================================================================
// WHAT: Phase 25 tests — operator CLI --adjudications mode displays a
//   draft's adjudication history read-only (never mutates, never publishes).
// WHY: Proves operators can inspect every audit record (all axes, in order,
//   with values/notes) while the draft stays byte-identical and no production
//   model ever loads on this path.
// DB: isolated mongodb-memory-server ONLY. The CLI child process receives the
//   throwaway URI via --mongo-uri; the real production database is never
//   connected (MONGO_URI is unset for the suite).
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("fs");
const path = require("path");

const { getExamEditionDraftModel } = require("../models/examEditionDraft");
const { saveDraft, getDraft, adjudicateDraft } = require("../pipeline/reviewPipeline");
const { buildUnknownEligibility } = require("../validators/examValidator");
const { parseArgs } = require("../cli/publish");
const {
  startIsolatedDb,
  connectRawDocuments,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

const CLI = path.join(__dirname, "..", "cli", "publish.js");
const SCOPED_CWD = path.join(__dirname, "..");

function validExam() {
  return {
    slug: "phase25-test-exam",
    name: "Phase25 Test Exam",
    fullForm: "Phase Twenty-Five Test Examination",
    conductingBody: "Phase Twenty-Five Test Board",
    officialWebsite: "http://127.0.0.1/",
    careerType: null,
    examType: null,
  };
}

function validEvidence() {
  return {
    sourceUrl: "http://127.0.0.1/",
    documentUrl: "http://127.0.0.1/bulletin.html",
    docType: "HTML",
    retrievedAt: new Date("2026-01-02T00:00:00Z"),
    section: "information-bulletin",
    page: null,
    excerpt: "Registration Start Date: 15 January 2026.",
    confidence: "HIGH",
    extractor: "registrationDates.v1",
  };
}

function unknownEdition() {
  const eligibility = buildUnknownEligibility();
  for (const axis of Object.values(eligibility)) {
    axis.evidence = validEvidence();
  }
  return {
    examSlug: "phase25-test-exam",
    year: 2026,
    cycle: "2026",
    registration: {
      startDate: new Date("2026-01-15T00:00:00Z"),
      endDate: new Date("2026-02-20T00:00:00Z"),
    },
    eligibility,
    sources: [validEvidence()],
    status: "DRAFT",
  };
}

describe("Phase 25 — operator CLI --adjudications (read-only history)", () => {
  let mongod;
  let mongoUri;
  let connection;
  let EditionDraft;
  let savedMongoUri;
  let savedScraperUri;

  function runCli(args) {
    const env = { ...process.env };
    delete env.MONGO_URI;
    delete env.SCRAPER_MONGO_URI;
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [CLI, ...args],
        { cwd: SCOPED_CWD, env, timeout: 120000 },
        (error, stdout, stderr) => {
          resolve({ code: error ? error.code || 1 : 0, stdout, stderr });
        }
      );
    });
  }

  function cliArgs(extra) {
    return [...extra, "--mongo-uri", mongoUri];
  }

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    savedScraperUri = process.env.SCRAPER_MONGO_URI;
    delete process.env.MONGO_URI;
    delete process.env.SCRAPER_MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("phase25_history"));
    ({ connection } = await connectRawDocuments(mongoUri));
    EditionDraft = getExamEditionDraftModel(connection);
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    if (savedScraperUri !== undefined)
      process.env.SCRAPER_MONGO_URI = savedScraperUri;
    assert.equal(connection.readyState, 0, "test connection must be closed");
  });

  async function freshDraftId() {
    const saved = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: unknownEdition(),
    });
    return String(saved._id);
  }

  async function historyDraftId() {
    const id = await freshDraftId();
    await adjudicateDraft(EditionDraft, id, {
      axis: "education",
      decision: "CONFIRM_VALUE",
      value: "Graduate",
      decidedBy: "operator-1",
      note: "UG track confirmed",
    });
    await adjudicateDraft(EditionDraft, id, {
      axis: "percentage",
      decision: "KEEP_UNKNOWN",
      decidedBy: "operator-2",
    });
    await adjudicateDraft(EditionDraft, id, {
      axis: "age",
      decision: "CONFIRM_VALUE",
      value: { min: 17, max: 25 },
      decidedBy: "operator-1",
    });
    return id;
  }

  it("1. empty history prints a clear empty state", async () => {
    const id = await freshDraftId();
    const { code, stdout } = await runCli(cliArgs(["--adjudications", id]));
    assert.equal(code, 0);
    assert.match(stdout, new RegExp(id));
    assert.match(stdout, /No adjudications recorded/);
  });

  it("2+5+6+7. one CONFIRM_VALUE record displays fully", async () => {
    const id = await freshDraftId();
    await adjudicateDraft(EditionDraft, id, {
      axis: "education",
      decision: "CONFIRM_VALUE",
      value: "Graduate",
      decidedBy: "operator-1",
      note: "UG track confirmed",
    });
    const { code, stdout } = await runCli(cliArgs(["--adjudications", id]));
    assert.equal(code, 0);
    assert.match(stdout, /axis: education/);
    assert.match(stdout, /decision: CONFIRM_VALUE/);
    assert.match(stdout, /Graduate/);
    assert.match(stdout, /operator-1/);
    assert.match(stdout, /decidedAt: \d{4}-\d{2}-\d{2}T/);
    assert.match(stdout, /UG track confirmed/);
  });

  it("3+4. multiple axes display, oldest first, KEEP_UNKNOWN needs no value", async () => {
    const id = await historyDraftId();
    const { code, stdout } = await runCli(cliArgs(["--adjudications", id]));
    assert.equal(code, 0);
    const eduAt = stdout.indexOf("axis: education");
    const pctAt = stdout.indexOf("axis: percentage");
    const ageAt = stdout.indexOf("axis: age");
    assert.ok(eduAt !== -1 && pctAt !== -1 && ageAt !== -1);
    assert.ok(eduAt < pctAt && pctAt < ageAt, "chronological order");
    assert.match(stdout, /decision: KEEP_UNKNOWN/);
    assert.match(stdout, /value: null/);
    assert.match(stdout, /operator-2/);
    assert.match(stdout, /"min": 17/);
  });

  it("8. inspection never modifies the draft", async () => {
    const id = await historyDraftId();
    const before = JSON.parse(JSON.stringify(await getDraft(EditionDraft, id)));
    const { code } = await runCli(cliArgs(["--adjudications", id]));
    assert.equal(code, 0);
    const after = JSON.parse(JSON.stringify(await getDraft(EditionDraft, id)));
    assert.deepEqual(after, before);
  });

  it("9. existing --adjudicate behavior is unchanged", async () => {
    const id = await freshDraftId();
    const { code, stdout } = await runCli(
      cliArgs([
        "--adjudicate", id,
        "--axis", "education",
        "--decision", "KEEP_UNKNOWN",
        "--by", "operator-9",
      ])
    );
    assert.equal(code, 0);
    assert.match(stdout, /ADJUDICATED/);
    assert.equal((await getDraft(EditionDraft, id)).status, "DRAFT");
  });

  it("10. invalid draft IDs fail cleanly", async () => {
    const malformed = await runCli(cliArgs(["--adjudications", "not-an-id"]));
    assert.notEqual(malformed.code, 0);
    const missing = await runCli(
      cliArgs(["--adjudications", "000000000000000000000001"])
    );
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /draft not found/);
  });

  it("mode mixing and arg parsing stay strict", async () => {
    const id = await freshDraftId();
    const mixed = await runCli(cliArgs(["--adjudications", id, "--confirm"]));
    assert.notEqual(mixed.code, 0);
    assert.match(mixed.stderr, /cannot be combined/);
    assert.deepEqual(parseArgs(["--adjudications", "abc"]).showAdjudications, "abc");
  });

  it("11. no production Exam model loads on this path", async () => {
    const id = await historyDraftId();
    const { code } = await runCli(cliArgs(["--adjudications", id]));
    assert.equal(code, 0);
    const collections = await connection.db.listCollections().toArray();
    const names = collections
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("system."));
    assert.ok(names.length > 0);
    for (const name of names) {
      assert.ok(name.startsWith("scraper_"), `unexpected collection ${name}`);
    }
    assert.ok(!names.includes("exams"));
  });

  it("12. no exam-specific literals in the display code", () => {
    const code = fs.readFileSync(CLI, "utf8");
    const executable = code.replace(/\/\/.*$/gm, "");
    assert.ok(
      !/jee-main|gate-2026|\bnta\b|\biit\b|upsc|\bneet\b/i.test(executable),
      "display code must name no exam"
    );
  });

  it("leaves no temporary/download artifacts in the repo", () => {
    const repoRoot = path.join(__dirname, "..");
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          entry.name.endsWith(".tmp") ||
          /^(download|temp).*\.pdf$/i.test(entry.name)
        ) {
          offenders.push(full);
        }
      }
    };
    walk(repoRoot);
    assert.deepEqual(offenders, []);
  });
});
