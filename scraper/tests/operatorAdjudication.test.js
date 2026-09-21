// =============================================================================
// scraper/tests/operatorAdjudication.test.js
// =============================================================================
// WHAT: Phase 14 tests — operator CLI --adjudicate mode as a thin layer over
//   reviewPipeline.adjudicateDraft() (no duplicated rules, never publishes).
// WHY: Proves operators can resolve UNKNOWN-with-evidence axes from the CLI
//   with explicit arguments, while failures exit non-zero and publish
//   behavior is untouched.
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
const { saveDraft, getDraft } = require("../pipeline/reviewPipeline");
const { extractEligibility } = require("../extractors/eligibility");
const { buildUnknownEligibility } = require("../validators/examValidator");
const { parseArgs } = require("../cli/publish");
const {
  startIsolatedDb,
  connectRawDocuments,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

const CLI = path.join(__dirname, "..", "cli", "publish.js");
const SCOPED_CWD = path.join(__dirname, "..");

const CTX = {
  sourceUrl: "http://127.0.0.1/",
  documentUrl: "http://127.0.0.1/bulletin.html",
  docType: "HTML",
  retrievedAt: new Date("2026-01-02T00:00:00Z"),
  section: "information-bulletin",
};

const MIXED_TEXT = [
  "Candidates who have completed a Bachelor's degree in Engineering are eligible to apply for the examination.",
  "Candidates holding an M.Sc. or equivalent Master's degree in Science may also apply for the examination.",
].join(" ");

function validExam() {
  return {
    slug: "phase14-test-exam",
    name: "Phase14 Test Exam",
    fullForm: "Phase Fourteen Test Examination",
    conductingBody: "Phase Fourteen Test Board",
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

function mixedEdition() {
  const extracted = extractEligibility(MIXED_TEXT, CTX);
  assert.equal(extracted.education.status, "UNKNOWN");
  return {
    examSlug: "phase14-test-exam",
    year: 2026,
    cycle: "2026",
    registration: {
      startDate: new Date("2026-01-15T00:00:00Z"),
      endDate: new Date("2026-02-20T00:00:00Z"),
    },
    eligibility: {
      ...buildUnknownEligibility(),
      education: extracted.education,
    },
    sources: [validEvidence(), extracted.education.evidence],
    status: "DRAFT",
  };
}

describe("Phase 14 — operator CLI --adjudicate (thin wiring, never publishes)", () => {
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
    ({ mongod, mongoUri } = await startIsolatedDb("phase14_cli"));
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

  async function mixedDraftId() {
    const saved = await saveDraft(EditionDraft, {
      exam: validExam(),
      edition: mixedEdition(),
    });
    return String(saved._id);
  }

  it("1+9. CONFIRM_VALUE adjudicates, keeps DRAFT, records audit", async () => {
    const id = await mixedDraftId();
    const { code, stdout } = await runCli(
      cliArgs([
        "--adjudicate", id,
        "--axis", "education",
        "--decision", "CONFIRM_VALUE",
        "--value", "Graduate",
        "--by", "operator-1",
        "--note", "UG track confirmed",
      ])
    );
    assert.equal(code, 0);
    assert.match(stdout, /ADJUDICATED/);
    assert.match(stdout, /no production publish occurred/);
    assert.match(stdout, new RegExp(id));
    assert.match(stdout, /education/);
    assert.match(stdout, /CONFIRM_VALUE/);
    assert.match(stdout, /Graduate/);
    assert.match(stdout, /KNOWN/);
    assert.match(stdout, /operator-1/);
    assert.match(stdout, /UG track confirmed/);

    const updated = await getDraft(EditionDraft, id);
    assert.equal(updated.status, "DRAFT");
    assert.equal(updated.edition.eligibility.education.status, "KNOWN");
    assert.equal(updated.edition.eligibility.education.minLevel, "Graduate");
    assert.ok(updated.edition.eligibility.education.evidence);
    assert.equal(updated.adjudications.length, 1);
    assert.equal(updated.adjudications[0].decision, "CONFIRM_VALUE");
  });

  it("2+9. KEEP_UNKNOWN preserves UNKNOWN with evidence and audit", async () => {
    const id = await mixedDraftId();
    const { code, stdout } = await runCli(
      cliArgs([
        "--adjudicate", id,
        "--axis", "education",
        "--decision", "KEEP_UNKNOWN",
        "--by", "operator-2",
      ])
    );
    assert.equal(code, 0);
    assert.match(stdout, /KEEP_UNKNOWN/);
    assert.match(stdout, /axis status: UNKNOWN/);

    const updated = await getDraft(EditionDraft, id);
    assert.equal(updated.status, "DRAFT");
    assert.equal(updated.edition.eligibility.education.status, "UNKNOWN");
    assert.equal(updated.edition.eligibility.education.minLevel, null);
    assert.ok(updated.edition.eligibility.education.evidence);
    assert.equal(updated.adjudications[0].value, null);
  });

  it("3. missing --by fails without side effects", async () => {
    const id = await mixedDraftId();
    const { code, stderr } = await runCli(
      cliArgs(["--adjudicate", id, "--axis", "education", "--decision", "KEEP_UNKNOWN"])
    );
    assert.notEqual(code, 0);
    assert.match(stderr, /--by/);
    assert.deepEqual((await getDraft(EditionDraft, id)).adjudications, []);
  });

  it("4. CONFIRM_VALUE without --value fails", async () => {
    const id = await mixedDraftId();
    const { code, stderr } = await runCli(
      cliArgs([
        "--adjudicate", id,
        "--axis", "education",
        "--decision", "CONFIRM_VALUE",
        "--by", "operator-1",
      ])
    );
    assert.notEqual(code, 0);
    assert.match(stderr, /canonical education level/);
    assert.deepEqual((await getDraft(EditionDraft, id)).adjudications, []);
  });

  it("5. KEEP_UNKNOWN with --value fails", async () => {
    const id = await mixedDraftId();
    const { code, stderr } = await runCli(
      cliArgs([
        "--adjudicate", id,
        "--axis", "education",
        "--decision", "KEEP_UNKNOWN",
        "--value", "Graduate",
        "--by", "operator-1",
      ])
    );
    assert.notEqual(code, 0);
    assert.match(stderr, /takes no value/);
    assert.deepEqual((await getDraft(EditionDraft, id)).adjudications, []);
  });

  it("6+7. invalid axis and invalid decision fail", async () => {
    const id = await mixedDraftId();
    const badAxis = await runCli(
      cliArgs([
        "--adjudicate", id,
        "--axis", "careerType",
        "--decision", "KEEP_UNKNOWN",
        "--by", "operator-1",
      ])
    );
    assert.notEqual(badAxis.code, 0);
    assert.match(badAxis.stderr, /not adjudicable/);

    const badDecision = await runCli(
      cliArgs([
        "--adjudicate", id,
        "--axis", "education",
        "--decision", "MAYBE",
        "--by", "operator-1",
      ])
    );
    assert.notEqual(badDecision.code, 0);
    assert.match(badDecision.stderr, /CONFIRM_VALUE \| KEEP_UNKNOWN/);
    assert.deepEqual((await getDraft(EditionDraft, id)).adjudications, []);
  });

  it("8. adjudication never publishes and rejects publish-mode mixing", async () => {
    const id = await mixedDraftId();
    const mixed = await runCli(
      cliArgs(["--adjudicate", id, "--confirm", "--axis", "education", "--decision", "KEEP_UNKNOWN", "--by", "op"])
    );
    assert.notEqual(mixed.code, 0);
    assert.match(mixed.stderr, /cannot be combined/);

    const ok = await runCli(
      cliArgs([
        "--adjudicate", id,
        "--axis", "education",
        "--decision", "KEEP_UNKNOWN",
        "--by", "operator-1",
      ])
    );
    assert.equal(ok.code, 0);
    // No publish machinery ran: no `exams` collection exists, and every
    // collection on the database is staging-owned.
    const collections = await connection.db.listCollections().toArray();
    const names = collections.map((c) => c.name).filter((n) => !n.startsWith("system."));
    assert.ok(!names.includes("exams"));
    for (const name of names) {
      assert.ok(name.startsWith("scraper_"), `unexpected collection ${name}`);
    }
  });

  it("10. publish CLI behavior is unchanged (dry-run still default)", async () => {
    const parsed = parseArgs(["--draft", "abc"]);
    assert.equal(parsed.draftId, "abc");
    assert.equal(parsed.adjudicateId, null);
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.confirm, false);
  });

  it("CLI adjudication duplicates no business rules", () => {
    const code = fs.readFileSync(CLI, "utf8");
    assert.ok(/adjudicateDraft/.test(code), "must delegate to adjudicateDraft");
    // Strip comments and string literals: usage examples legitimately name
    // values like "Graduate" — only executable logic counts.
    const executable = code
      .replace(/\/\/.*$/gm, "")
      .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, '""');
    assert.ok(!/CANONICAL_EDUCATION|normalizeAdjudicated/.test(executable));
    assert.ok(!/minLevel|appearingAllowed/.test(executable));
    assert.ok(!/cron|redis|kafka|apify|openai|anthropic/i.test(code));
    assert.ok(!/\.save\(|insertMany|updateOne|deleteOne|deleteMany|dropDatabase/.test(executable));
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
