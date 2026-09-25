// =============================================================================
// scraper/tests/examDiscovery.test.js
// =============================================================================
// WHAT: STEP 2 tests — automated exam discovery stops at DISCOVERED.
//   Covers discovery (name/source/evidence/status), deduplication (same
//   sighting reuses, distinct names/editions stay apart, stable identity),
//   safety boundaries (never publishes, no verification bypass, separate
//   collection), missing data (nulls, never guessed), seed validity, and
//   engine genericity (no exam names in discovery code or seed patterns).
// WHY: Locks the discovery contract before verification/crawling exist:
//   candidates are evidenced guesses, never facts, and no path promotes them.
// DB: isolated mongodb-memory-server only; MONGO_URI unset during the suite.
//   Fixtures are inline HTML / local servers — never live external sites.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const mongoose = require("mongoose");
const path = require("path");

const {
  SEEDS,
  validateSeeds,
  getEnabledSeeds,
  DEFAULT_INCLUDE_PATTERNS,
} = require("../registry/discovery/seeds");
const {
  EXAM_CANDIDATE_COLLECTION,
  CANDIDATE_STATUSES,
  FUTURE_CANDIDATE_STATUSES,
  getExamCandidateModel,
} = require("../models/examCandidate");
const { EDITION_DRAFT_COLLECTION } = require("../models/examEditionDraft");
const { getPublishReceiptModel } = require("../models/publishReceipt");
const {
  candidateIdFor,
  discoverCandidatesFromHtml,
  discoverFromSeed,
  saveCandidates,
  transitionCandidateStatus,
} = require("../discovery/examDiscovery");
const { dryRunPublish } = require("../publish/publishExecutor");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

const RETRIEVED_AT = new Date("2026-09-23T00:00:00Z");

function testSeed(overrides = {}) {
  return {
    id: "step2-test-authority",
    label: "Step2 Test Authority",
    url: "http://127.0.0.1/",
    type: "authority",
    enabled: true,
    notes: "",
    rules: {
      includePatterns: DEFAULT_INCLUDE_PATTERNS,
      excludePatterns: [],
      maxCandidates: 50,
    },
    ...overrides,
  };
}

const FIXTURE_HTML =
  "<html><head><title>Test Board Examinations</title></head><body>" +
  "<h1>Upcoming examinations</h1>" +
  '<a href="/exams/alpha-2027.html">Alpha Entrance Examination 2027</a>' +
  '<a href="/exams/beta.html">Beta Admission Notification</a>' +
  '<a href="/login">Login</a>' +
  '<a href="/about">About us</a>' +
  "</body></html>";

describe("STEP 2 — exam discovery", () => {
  let mongod;
  let mongoUri;
  let connection;
  let ExamCandidate;
  let Receipt;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("step2_discovery"));
    connection = await mongoose.createConnection(mongoUri).asPromise();
    ExamCandidate = getExamCandidateModel(connection);
    Receipt = getPublishReceiptModel(connection);
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0, "discovery must not leak connections");
  });

  it("1. finds candidates with names, source URLs, evidence, DISCOVERED", () => {
    const found = discoverCandidatesFromHtml(testSeed(), FIXTURE_HTML, {
      sourceUrl: "http://127.0.0.1/",
      retrievedAt: RETRIEVED_AT,
    });
    assert.equal(found.length, 2);
    const byName = Object.fromEntries(found.map((c) => [c.name, c]));
    assert.ok(byName["Alpha Entrance Examination 2027"]);
    assert.ok(byName["Beta Admission Notification"]);

    const alpha = byName["Alpha Entrance Examination 2027"];
    assert.equal(alpha.sourceUrl, "http://127.0.0.1/");
    assert.equal(alpha.sourceDomain, "127.0.0.1");
    assert.equal(alpha.examUrl, "http://127.0.0.1/exams/alpha-2027.html");
    assert.equal(alpha.year, 2027);
    assert.equal(alpha.edition, "2027");
    assert.equal(alpha.status, "DISCOVERED");
    assert.equal(alpha.evidence.length, 1);
    assert.equal(alpha.evidence[0].seedId, "step2-test-authority");
    assert.equal(alpha.evidence[0].matchedText, "Alpha Entrance Examination 2027");
    assert.ok(alpha.evidence[0].matchedPattern);
    assert.deepEqual(new Date(alpha.evidence[0].retrievedAt), RETRIEVED_AT);

    // Boilerplate links ("Login", "About us") never become candidates.
    assert.ok(!found.some((c) => /login|about/i.test(c.name)));
  });

  it("2. discoverFromSeed fetches with an injected transport (no network)", async () => {
    const fetchHtml = async (url) => ({ url, text: FIXTURE_HTML, status: 200 });
    const found = await discoverFromSeed(testSeed(), { fetchHtml, retrievedAt: RETRIEVED_AT });
    assert.equal(found.length, 2);
    assert.ok(found.every((c) => c.status === "DISCOVERED"));
  });

  it("3. discoverFromSeed uses the existing HTTP fetcher against a local server", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const found = await discoverFromSeed(testSeed({ url: `${base}/`, id: "step2-local" }), {
        retrievedAt: RETRIEVED_AT,
      });
      assert.equal(found.length, 2);
      assert.ok(found.every((c) => c.sourceUrl.startsWith("http://127.0.0.1")));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("4. same candidate saved twice reuses one document with merged evidence", async () => {
    const first = discoverCandidatesFromHtml(testSeed(), FIXTURE_HTML, {
      sourceUrl: "http://127.0.0.1/",
      retrievedAt: RETRIEVED_AT,
    });
    const r1 = await saveCandidates(ExamCandidate, first);
    assert.equal(r1.created.length, 2);
    assert.equal(r1.reused.length, 0);

    // Same page re-sighted from a second seed: no duplicate document.
    const second = discoverCandidatesFromHtml(
      testSeed({ id: "step2-second-seed", url: "http://127.0.0.1/other/" }),
      FIXTURE_HTML,
      { sourceUrl: "http://127.0.0.1/other/", retrievedAt: new Date("2026-09-24T00:00:00Z") }
    );
    const r2 = await saveCandidates(ExamCandidate, second);
    assert.equal(r2.created.length, 0);
    assert.equal(r2.reused.length, 2);
    assert.equal(await ExamCandidate.countDocuments({}), 2);

    const alpha = await ExamCandidate.findOne({ name: "Alpha Entrance Examination 2027" }).lean();
    assert.equal(alpha.evidence.length, 2);
    assert.deepEqual([...alpha.discoverySources].sort(), ["step2-second-seed", "step2-test-authority"]);
  });

  it("5. different names and different editions stay separate", async () => {
    await ExamCandidate.deleteMany({});
    const html =
      "<html><head><title>t</title></head><body>" +
      '<a href="/a">Gamma Entrance Examination 2026</a>' +
      '<a href="/b">Gamma Entrance Examination 2027</a>' +
      '<a href="/c">Delta Admission Notification</a>' +
      "</body></html>";
    const found = discoverCandidatesFromHtml(testSeed(), html, {
      sourceUrl: "http://127.0.0.1/",
      retrievedAt: RETRIEVED_AT,
    });
    assert.equal(found.length, 3);
    assert.equal(new Set(found.map((c) => c.candidateId)).size, 3);
    const years = Object.fromEntries(found.map((c) => [c.name, c.year]));
    assert.equal(years["Gamma Entrance Examination 2026"], 2026);
    assert.equal(years["Gamma Entrance Examination 2027"], 2027);
    const r = await saveCandidates(ExamCandidate, found);
    assert.equal(r.created.length, 3);
  });

  it("6. identity is stable across runs (reproducibility)", () => {
    const a = discoverCandidatesFromHtml(testSeed(), FIXTURE_HTML, {
      sourceUrl: "http://127.0.0.1/",
      retrievedAt: RETRIEVED_AT,
    });
    const b = discoverCandidatesFromHtml(testSeed(), FIXTURE_HTML, {
      sourceUrl: "http://127.0.0.1/",
      retrievedAt: new Date("2026-10-01T00:00:00Z"),
    });
    assert.deepEqual(
      a.map((c) => c.candidateId).sort(),
      b.map((c) => c.candidateId).sort()
    );
    assert.equal(candidateIdFor("Alpha Entrance Examination 2027", 2027), a[0].candidateId);
  });

  it("7. missing data stays null and is never guessed", async () => {
    const found = discoverCandidatesFromHtml(testSeed(), FIXTURE_HTML, {
      sourceUrl: "http://127.0.0.1/",
      retrievedAt: RETRIEVED_AT,
    });
    const beta = found.find((c) => c.name === "Beta Admission Notification");
    assert.equal(beta.year, null);
    assert.equal(beta.edition, null);
    assert.equal(beta.conductingBody, null);
    assert.equal(beta.description, null);

    await ExamCandidate.deleteMany({});
    await saveCandidates(ExamCandidate, [beta]);
    const stored = await ExamCandidate.findOne({ candidateId: beta.candidateId }).lean();
    assert.equal(stored.year, null);
    assert.equal(stored.conductingBody, null);
    assert.ok(!("official" in stored), "no official flag may exist on candidates");
    assert.ok(!("isOfficial" in stored), "no official flag may exist on candidates");
    assert.ok(!("verified" in stored), "no verified flag may exist on candidates");
  });

  it("8. DISCOVERED candidates cannot be published", async () => {
    await ExamCandidate.deleteMany({});
    const [one] = discoverCandidatesFromHtml(testSeed(), FIXTURE_HTML, {
      sourceUrl: "http://127.0.0.1/",
      retrievedAt: RETRIEVED_AT,
    });
    const { created } = await saveCandidates(ExamCandidate, [one]);
    // The publish executor only reads staging drafts: a candidate model is
    // refused by its collection guard before any draft lookup happens.
    await assert.rejects(
      dryRunPublish(ExamCandidate, { Receipt, draftId: created[0] }),
      /scraper_editiondrafts/
    );
  });

  it("9. DISCOVERED cannot bypass verification", async () => {
    const [one] = discoverCandidatesFromHtml(testSeed(), FIXTURE_HTML, {
      sourceUrl: "http://127.0.0.1/",
      retrievedAt: RETRIEVED_AT,
    });
    await ExamCandidate.deleteMany({});
    await saveCandidates(ExamCandidate, [one]);
    await assert.rejects(
      transitionCandidateStatus(ExamCandidate, one.candidateId, "SOURCE_VERIFIED"),
      /not implemented/
    );
    await assert.rejects(
      transitionCandidateStatus(ExamCandidate, one.candidateId, "VERIFIED"),
      /not implemented/
    );
    const same = await transitionCandidateStatus(ExamCandidate, one.candidateId, "DISCOVERED");
    assert.equal(same.status, "DISCOVERED");
  });

  it("10. candidate collection stays separate from drafts and production", () => {
    assert.equal(EXAM_CANDIDATE_COLLECTION, "scraper_exam_candidates");
    assert.notEqual(EXAM_CANDIDATE_COLLECTION, EDITION_DRAFT_COLLECTION);
    assert.notEqual(EXAM_CANDIDATE_COLLECTION, "exams");
    assert.deepEqual(CANDIDATE_STATUSES, ["DISCOVERED", "SOURCE_VERIFIED", "SOURCE_REVIEW_REQUIRED"]);
    assert.ok(!CANDIDATE_STATUSES.includes("PUBLISHED"));
    assert.ok(FUTURE_CANDIDATE_STATUSES.includes("REJECTED"));
  });

  it("11. production seeds are valid, enabled, and authoritative-only", () => {
    assert.equal(validateSeeds(SEEDS).success, true);
    const enabled = getEnabledSeeds();
    assert.equal(enabled.length, 5);
    for (const seed of enabled) {
      assert.ok(seed.url.startsWith("https://"), `${seed.id} must use https`);
      assert.equal(seed.type, "authority");
    }
    assert.deepEqual(
      enabled.map((s) => s.id).sort(),
      ["gate-2026-authority", "jee-advanced-authority", "jee-main-authority", "neet-authority", "upsc-authority"]
    );
  });

  it("12. discovery carries no exam-specific logic or names", () => {
    // Engine + model: no exam/board/body names anywhere outside comments.
    for (const relative of ["discovery/examDiscovery.js", "models/examCandidate.js"]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      const executable = code.replace(/\/\/.*$/gm, "");
      assert.ok(
        !/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable),
        `${relative} must not name exams, boards, or bodies`
      );
    }
    // Seeds: known source URLs are data with documented provenance, but the
    // match patterns themselves must stay generic (no exam names), and no
    // file may branch on any exam, board, or host.
    const { DEFAULT_EXCLUDE_PATTERNS } = require("../registry/discovery/seeds");
    const patternText = [...DEFAULT_INCLUDE_PATTERNS, ...DEFAULT_EXCLUDE_PATTERNS].join("\n");
    assert.ok(
      !/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(patternText),
      "seed patterns must be generic signals, never exam names"
    );
    for (const relative of ["discovery/examDiscovery.js", "registry/discovery/seeds.js"]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      assert.ok(
        !/\bif\b[^\n]*(jee|gate|neet|upsc|nta|iit|nic\.in|gov\.in)/i.test(code),
        `${relative} must not branch on any exam, board, or host`
      );
    }
  });
});
