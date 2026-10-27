const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");
const { getExamCandidateModel } = require("../models/examCandidate");
const { getSourceProfileModel } = require("../models/sourceProfile");
const { saveCandidates } = require("../discovery/examDiscovery");
const {
  readConfig,
  discoverFromOpenSerp,
  discoverAndSaveFromOpenSerp,
  discoverVerifyAndProfileFromOpenSerp,
} = require("../discovery/openSerpProvider");

let mongod;
let connection;
let ExamCandidate;
let SourceProfile;

before(async () => {
  const db = await startIsolatedDb("openserp_provider");
  mongod = db.mongod;
  connection = await mongoose.createConnection(db.mongoUri).asPromise();
  ExamCandidate = getExamCandidateModel(connection);
  SourceProfile = getSourceProfileModel(connection);
});

after(async () => {
  await closeIsolatedDb({ mongod, connection });
});

describe("OpenSERP discovery provider", () => {
  it("reads bounded configuration and defaults to disabled", () => {
    assert.deepEqual(readConfig({}), {
      enabled: false,
      baseUrl: "http://127.0.0.1:7000",
      queryLimit: 5,
      resultsPerQuery: 5,
      timeoutMs: 5000,
    });
    const config = readConfig({ OPENSERP_ENABLED: "true", OPENSERP_QUERY_LIMIT: "1000", OPENSERP_RESULTS_PER_QUERY: "9" });
    assert.equal(config.queryLimit, 100);
    assert.equal(config.resultsPerQuery, 9);
  });

  it("requests configured queries and normalizes title, URL/domain, snippet, and SERP evidence", async () => {
    const calls = [];
    const provider = async (url) => {
      calls.push(url);
      const query = url.searchParams.get("text");
      return query === "first"
        ? { results: [
            { title: "Example Entrance Examination 2027", url: "https://board.example.gov.in/exam", snippet: "Apply soon", score: 0.99 },
            { title: "Example Entrance Examination 2027", url: "https://board.example.gov.in/exam#duplicate", snippet: "duplicate" },
            { title: "bad", url: "javascript:alert(1)" },
          ] }
        : [{ title: "Another Admission Notification", link: "http://other.example/notice", description: "Details" }];
    };
    const candidates = await discoverFromOpenSerp(["first", "second", "third"], {
      config: { enabled: true, baseUrl: "http://127.0.0.1:7000", queryLimit: 2, resultsPerQuery: 5, timeoutMs: 1000 },
      requestJson: provider,
      discoveredAt: new Date("2026-10-01T00:00:00Z"),
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].pathname, "/duck/search");
    assert.equal(calls[0].searchParams.get("text"), "first");
    assert.equal(calls[0].searchParams.get("limit"), "5");
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].status, "DISCOVERED");
    assert.equal(candidates[0].sourceDomain, "board.example.gov.in");
    assert.equal(candidates[0].evidence[0].searchQuery, "first");
    assert.equal(candidates[0].evidence[0].searchEngine, "duck");
    assert.equal(candidates[0].evidence[0].rank, 1);
    assert.equal(candidates[0].evidence[0].snippet, "Apply soon");
    assert.equal(candidates[0].evidence[0].resultMetadata.score, 0.99);
    assert.equal(candidates[0].evidence[0].retrievedAt.toISOString(), "2026-10-01T00:00:00.000Z");
  });

  it("continues after rate limits, connection failures, and malformed response shapes", async () => {
    const errors = [];
    const candidates = await discoverFromOpenSerp(["limited", "failed", "malformed", "works"], {
      config: { enabled: true, baseUrl: "http://127.0.0.1:7000", queryLimit: 4, resultsPerQuery: 5 },
      requestJson: async (url) => {
        const query = url.searchParams.get("text");
        if (query === "limited") throw Object.assign(new Error("rate limited"), { code: "OPEN_SERP_RATE_LIMIT" });
        if (query === "failed") throw new Error("connection refused");
        if (query === "malformed") return { unexpected: "shape" };
        return [{ title: "Useful Examination", url: "https://example.org/exam" }];
      },
      onError: (error, query) => errors.push([query, error.message]),
    });
    assert.equal(candidates.length, 1);
    assert.equal(errors.length, 2);
    assert.deepEqual(errors.map(([query]) => query), ["limited", "failed"]);
  });

  it("does not call provider when disabled and excludes already stored URLs before persistence", async () => {
    await ExamCandidate.deleteMany({});
    let called = false;
    assert.deepEqual(await discoverFromOpenSerp(["ignored"], { requestJson: async () => { called = true; } }), []);
    assert.equal(called, false);

    const [existing] = await discoverFromOpenSerp(["exam"], {
      config: { enabled: true, baseUrl: "http://127.0.0.1:7000", queryLimit: 1, resultsPerQuery: 5 },
      requestJson: async () => [{ title: "Existing Exam", url: "https://example.org/exam" }],
    });
    await saveCandidates(ExamCandidate, [existing]);
    const result = await discoverAndSaveFromOpenSerp(ExamCandidate, ["exam"], {
      config: { enabled: true, baseUrl: "http://127.0.0.1:7000", queryLimit: 1, resultsPerQuery: 5 },
      requestJson: async () => [{ title: "Existing Exam", url: "https://example.org/exam" }],
    });
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.candidates, []);
    assert.equal(await ExamCandidate.countDocuments({}), 1);
  });

  it("persists as DISCOVERED, then uses established verification and profiling", async () => {
    await ExamCandidate.deleteMany({});
    await SourceProfile.deleteMany({});
    const result = await discoverVerifyAndProfileFromOpenSerp(ExamCandidate, SourceProfile, ["exam"], {
      config: { enabled: true, baseUrl: "http://127.0.0.1:7000", queryLimit: 1, resultsPerQuery: 5 },
      requestJson: async () => [{ title: "Unmapped Entrance Examination", url: "https://untrusted.example.gov.in/exam", snippet: "Strong ranking" }],
      discoveredAt: new Date("2026-10-01T00:00:00Z"),
    });
    assert.equal(result.created.length, 1);
    assert.equal(result.processed.length, 1);
    assert.equal(result.processed[0].candidate.status, "SOURCE_REVIEW_REQUIRED");
    assert.equal(result.processed[0].profile.review.required, true);
    assert.equal(result.processed[0].profile.profile.type, "UNKNOWN");
    assert.equal(result.processed[0].profile.verification.signals.find((signal) => signal.signal === "https").result, "supporting");
  });
});
