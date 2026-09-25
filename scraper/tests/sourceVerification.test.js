// =============================================================================
// scraper/tests/sourceVerification.test.js
// =============================================================================
// WHAT: STEP 3 tests — source verification (DISCOVERED -> SOURCE_VERIFIED or
//   SOURCE_REVIEW_REQUIRED) and source profiling (STATIC_HTML /
//   JAVASCRIPT_HTML / PDF / MIXED / UNKNOWN + transport recommendation).
// WHY: Locks the verification contract before candidate crawling exists:
//   authority is proven by configured domain+body+https conjunction only;
//   everything else is REVIEW_REQUIRED with persisted evidence; profiling
//   never fetches anything and never changes candidate status by itself.
// DB: isolated mongodb-memory-server only; MONGO_URI unset during the suite.
//   Fixtures are inline objects/HTML — never live external sites.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");

const { AUTHORITIES, validateAuthorities } = require("../registry/discovery/authorities");
const {
  EXAM_CANDIDATE_COLLECTION,
  CANDIDATE_STATUSES,
  getExamCandidateModel,
} = require("../models/examCandidate");
const {
  SOURCE_PROFILE_COLLECTION,
  VERIFICATION_STATUSES,
  PROFILE_TYPES,
  TRANSPORT_TYPES,
  DOCUMENT_TYPES,
  getSourceProfileModel,
} = require("../models/sourceProfile");
const {
  verifySource,
  applyVerification,
} = require("../discovery/sourceVerification");
const { profileFromSignals, profileCandidate } = require("../discovery/sourceProfiler");
const { saveCandidates } = require("../discovery/examDiscovery");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

const RETRIEVED_AT = new Date("2026-09-23T00:00:00Z");

// Trusted adapter stand-ins mirror the registry shape (slug, conductingBody,
// officialWebsite) without importing exam identity into these tests.
const TRUSTED_ADAPTERS = [
  {
    slug: "alpha-exam",
    conductingBody: "Alpha Testing Board",
    officialWebsite: "https://alpha-board.example.gov.in/",
  },
  {
    slug: "beta-exam",
    conductingBody: "Beta Institute of Examinations",
    officialWebsite: "https://beta-exams.example.ac.in/",
  },
];

const TRUSTED_AUTHORITIES = [
  {
    id: "alpha-board",
    body: "Alpha Testing Board",
    aliases: ["ATB"],
    domains: ["alpha-board.example.gov.in"],
    provenance: "test fixture",
  },
];

function candidate(overrides = {}) {
  return {
    candidateId: "dsc-test-0001",
    name: "Alpha Entrance Examination 2027",
    conductingBody: "Alpha Testing Board",
    sourceUrl: "https://alpha-board.example.gov.in/exams/alpha-2027.html",
    sourceDomain: "alpha-board.example.gov.in",
    discoverySource: "step3-test-seed",
    ...overrides,
  };
}

describe("STEP 3 — source verification", () => {
  let mongod;
  let mongoUri;
  let connection;
  let ExamCandidate;
  let SourceProfile;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("step3_verification"));
    connection = await mongoose.createConnection(mongoUri).asPromise();
    ExamCandidate = getExamCandidateModel(connection);
    SourceProfile = getSourceProfileModel(connection);
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0, "verification must not leak connections");
  });

  it("1. trusted domain + matching body + https verifies", () => {
    const result = verifySource(candidate(), {
      authorities: TRUSTED_AUTHORITIES,
      adapters: TRUSTED_ADAPTERS,
      decidedAt: RETRIEVED_AT,
    });
    assert.equal(result.status, "SOURCE_VERIFIED");
    assert.ok(result.reason.includes("alpha-board.example.gov.in"));
    const byName = Object.fromEntries(result.signals.map((s) => [s.signal, s]));
    assert.equal(byName["exact-domain-trust"].result, "match");
    assert.equal(byName["conducting-body-match"].result, "match");
    assert.ok(byName["exact-domain-trust"].detail.includes("alpha-exam"));
    assert.deepEqual(new Date(result.decidedAt), RETRIEVED_AT);
  });

  it("2. unknown domain resolves to review, never verified", () => {
    const result = verifySource(
      candidate({
        sourceUrl: "https://unknown-exam-portal.example.com/alpha-2027.html",
        sourceDomain: "unknown-exam-portal.example.com",
      }),
      { authorities: TRUSTED_AUTHORITIES, adapters: TRUSTED_ADAPTERS }
    );
    assert.equal(result.status, "SOURCE_REVIEW_REQUIRED");
    assert.ok(result.reason.includes("domain not in trusted configuration"));
  });

  it("3. https alone never proves authority", () => {
    const result = verifySource(
      candidate({
        conductingBody: null,
        sourceUrl: "https://no-mapping-here.example.net/exam.html",
        sourceDomain: "no-mapping-here.example.net",
      }),
      { authorities: TRUSTED_AUTHORITIES, adapters: TRUSTED_ADAPTERS }
    );
    assert.equal(result.status, "SOURCE_REVIEW_REQUIRED");
    const byName = Object.fromEntries(result.signals.map((s) => [s.signal, s]));
    assert.equal(byName["https"].result, "supporting");
    assert.ok(result.reason.includes("conducting body unknown"));
  });

  it("4. conflicting conducting body resolves to review", () => {
    const result = verifySource(candidate({ conductingBody: "Gamma Other Board" }), {
      authorities: TRUSTED_AUTHORITIES,
      adapters: TRUSTED_ADAPTERS,
    });
    assert.equal(result.status, "SOURCE_REVIEW_REQUIRED");
    const byName = Object.fromEntries(result.signals.map((s) => [s.signal, s]));
    assert.equal(byName["conducting-body-match"].result, "mismatch");
    assert.ok(result.reason.includes("conflicts"));
  });

  it("5. government-looking domain without mapping still needs review", () => {
    const result = verifySource(
      candidate({
        conductingBody: null,
        sourceUrl: "https://plausible-board.example.gov.in/exam.html",
        sourceDomain: "plausible-board.example.gov.in",
      }),
      { authorities: [], adapters: [] }
    );
    assert.equal(result.status, "SOURCE_REVIEW_REQUIRED");
    const byName = Object.fromEntries(result.signals.map((s) => [s.signal, s]));
    assert.equal(byName["gov-domain-heuristic"].result, "supporting");
  });

  it("6. verification evidence persists and advances the candidate", async () => {
    await ExamCandidate.deleteMany({});
    await SourceProfile.deleteMany({});
    await saveCandidates(ExamCandidate, [
      { ...candidate(), discoverySource: "step3-test-seed", discoveredAt: RETRIEVED_AT, status: "DISCOVERED", evidence: [] },
    ]);
    const { candidate: updated, profile, result } = await applyVerification(
      ExamCandidate,
      SourceProfile,
      "dsc-test-0001",
      { authorities: TRUSTED_AUTHORITIES, adapters: TRUSTED_ADAPTERS }
    );
    assert.equal(result.status, "SOURCE_VERIFIED");
    assert.equal(updated.status, "SOURCE_VERIFIED");
    assert.equal(profile.candidateId, "dsc-test-0001");
    assert.equal(profile.verification.status, "SOURCE_VERIFIED");
    assert.ok(profile.verification.signals.length >= 4);
    assert.ok(profile.verification.reason);
    assert.equal(profile.review.required, false);

    const reread = await ExamCandidate.findOne({ candidateId: "dsc-test-0001" }).lean();
    assert.equal(reread.status, "SOURCE_VERIFIED");
  });

  it("7. insufficient evidence persists a review-required profile", async () => {
    await ExamCandidate.deleteMany({});
    await SourceProfile.deleteMany({});
    await saveCandidates(ExamCandidate, [
      {
        ...candidate({ candidateId: "dsc-test-0002", conductingBody: null }),
        discoverySource: "step3-test-seed",
        discoveredAt: RETRIEVED_AT,
        status: "DISCOVERED",
        evidence: [],
      },
    ]);
    const { candidate: updated, profile } = await applyVerification(
      ExamCandidate,
      SourceProfile,
      "dsc-test-0002",
      { authorities: TRUSTED_AUTHORITIES, adapters: TRUSTED_ADAPTERS }
    );
    assert.equal(updated.status, "SOURCE_REVIEW_REQUIRED");
    assert.equal(profile.verification.status, "SOURCE_REVIEW_REQUIRED");
    assert.equal(profile.review.required, true);
    assert.ok(profile.review.reasons.length > 0);
  });

  it("8. only DISCOVERED candidates may be verified", async () => {
    await ExamCandidate.deleteMany({});
    await SourceProfile.deleteMany({});
    await saveCandidates(ExamCandidate, [
      { ...candidate({ candidateId: "dsc-test-0008" }), discoverySource: "step3-test-seed", discoveredAt: RETRIEVED_AT, status: "DISCOVERED", evidence: [] },
    ]);
    await applyVerification(ExamCandidate, SourceProfile, "dsc-test-0008", {
      authorities: TRUSTED_AUTHORITIES,
      adapters: TRUSTED_ADAPTERS,
    });
    await assert.rejects(
      applyVerification(ExamCandidate, SourceProfile, "dsc-test-0008", {
        authorities: TRUSTED_AUTHORITIES,
        adapters: TRUSTED_ADAPTERS,
      }),
      /only DISCOVERED/
    );
    await assert.rejects(
      applyVerification(ExamCandidate, SourceProfile, "dsc-missing", {
        authorities: TRUSTED_AUTHORITIES,
        adapters: TRUSTED_ADAPTERS,
      }),
      /not found/
    );
  });
});

describe("STEP 3 — source profiling", () => {
  it("9. plain HTML profiles STATIC_HTML over HTTP", () => {
    const out = profileFromSignals({
      url: "https://example.gov.in/exams.html",
      contentType: "text/html",
      html: "<html><head><title>t</title></head><body><p>dates here</p></body></html>",
    });
    assert.equal(out.type, "STATIC_HTML");
    assert.equal(out.transport, "HTTP");
    assert.equal(out.documentTypes, "HTML");
    assert.equal(out.requiresJavaScript, false);
    assert.ok(out.signals.length > 0);
  });

  it("10. trusted js render profiles JAVASCRIPT_HTML over BROWSER", () => {
    const out = profileFromSignals({
      url: "https://js-shell.example.gov.in/",
      contentType: "text/html",
      html: "<html><body><div id=\"app\">loading</div></body></html>",
      adapterRender: "js",
    });
    assert.equal(out.type, "JAVASCRIPT_HTML");
    assert.equal(out.transport, "BROWSER");
    assert.equal(out.requiresJavaScript, true);
  });

  it("11. PDF addresses profile PDF over HTTP", () => {
    const out = profileFromSignals({
      url: "https://example.gov.in/documents/bulletin.pdf",
      contentType: "application/pdf",
    });
    assert.equal(out.type, "PDF");
    assert.equal(out.transport, "HTTP");
    assert.equal(out.documentTypes, "PDF");
    assert.equal(out.requiresJavaScript, false);
  });

  it("12. HTML linking PDFs profiles MIXED", () => {
    const out = profileFromSignals({
      url: "https://example.gov.in/notices.html",
      contentType: "text/html",
      html: "<html><body><a href=\"/docs/notice.pdf\">Notification</a></body></html>",
    });
    assert.equal(out.type, "MIXED");
    assert.equal(out.transport, "HTTP");
    assert.equal(out.documentTypes, "MIXED");
  });

  it("13. no signals fall back to UNKNOWN", () => {
    const out = profileFromSignals({ url: "https://example.net/" });
    assert.equal(out.type, "UNKNOWN");
    assert.equal(out.transport, "UNKNOWN");
    assert.equal(out.documentTypes, "UNKNOWN");
    assert.equal(out.requiresJavaScript, null);
  });

  it("14. generic scripts never imply JS rendering", () => {
    const out = profileFromSignals({
      url: "https://example.net/page.html",
      html: "<html><head><script src=\"analytics.js\"></script></head><body><p>hi</p></body></html>",
    });
    assert.equal(out.type, "STATIC_HTML");
    assert.equal(out.requiresJavaScript, false);
  });

  it("15. profileCandidate resolves adapter render without fetching", async () => {
    const cand = candidate({
      sourceUrl: "https://beta-exams.example.ac.in/",
      sourceDomain: "beta-exams.example.ac.in",
      examUrl: null,
    });
    const staticOut = profileCandidate(cand, {
      adapters: [{ slug: "beta-exam", officialWebsite: "https://beta-exams.example.ac.in/", render: "static" }],
    });
    assert.equal(staticOut.type, "STATIC_HTML");
    const jsOut = profileCandidate(cand, {
      adapters: [{ slug: "beta-exam", officialWebsite: "https://beta-exams.example.ac.in/", render: "js" }],
    });
    assert.equal(jsOut.type, "JAVASCRIPT_HTML");
    assert.equal(jsOut.transport, "BROWSER");
  });
});

describe("STEP 3 — lifecycle safety and boundaries", () => {
  it("16. lifecycle holds exactly the Step 3 states; publishing stays unreachable", () => {
    assert.deepEqual(CANDIDATE_STATUSES, ["DISCOVERED", "SOURCE_VERIFIED", "SOURCE_REVIEW_REQUIRED"]);
    assert.ok(!CANDIDATE_STATUSES.includes("PUBLISHED"));
    assert.deepEqual(VERIFICATION_STATUSES, ["SOURCE_VERIFIED", "SOURCE_REVIEW_REQUIRED"]);
    assert.deepEqual(PROFILE_TYPES, ["STATIC_HTML", "JAVASCRIPT_HTML", "PDF", "MIXED", "UNKNOWN"]);
    assert.deepEqual(TRANSPORT_TYPES, ["HTTP", "BROWSER", "UNKNOWN"]);
    assert.deepEqual(DOCUMENT_TYPES, ["HTML", "PDF", "MIXED", "UNKNOWN"]);
  });

  it("17. authority mappings are valid and strictly repo-derived", () => {
    assert.equal(validateAuthorities(AUTHORITIES).success, true);
    assert.equal(AUTHORITIES.length, 3);
    for (const entry of AUTHORITIES) {
      assert.ok(entry.provenance.includes("registry/exams/"));
      assert.ok(entry.domains.length > 0);
    }
  });

  it("18. Step 3 modules carry no exam-specific logic and perform no I/O", () => {
    for (const relative of [
      "discovery/sourceVerification.js",
      "discovery/sourceProfiler.js",
      "registry/discovery/authorities.js",
      "models/sourceProfile.js",
    ]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      // Strip line comments AND string literals: data (provenance strings,
      // configured domains, generic suffixes) is reviewed content, not logic.
      // What remains must not name exams, boards, bodies, or cities.
      const executable = code
        .replace(/\/\/.*$/gm, "")
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "");
      assert.ok(
        !/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b|\bguwahati\b|\broorkee\b/i.test(executable),
        `${relative} must not name exams, boards, bodies, or cities`
      );
      assert.ok(
        !/\bif\b[^\n]*(jee|gate|neet|upsc|nta|iit|nic\.in|gov\.in|guwahati|roorkee)/i.test(code),
        `${relative} must not branch on any exam, board, or host`
      );
      assert.ok(
        !/require\(["'].*(httpFetcher|browserFetcher|crawleeTransport|publish\/|axios|playwright|crawlee)["']\)/.test(code),
        `${relative} must not fetch, crawl, or publish`
      );
    }
  });
});
