// =============================================================================
// STEP 25 tests — read-only freshness dashboard data
// =============================================================================

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const { getExamCandidateModel } = require("../models/examCandidate");
const { getSurveillanceStateModel } = require("../models/surveillanceState");
const { getReviewStateModel } = require("../models/reviewState");
const { getAllowlistDeclarationModel } = require("../models/allowlistDeclaration");
const {
  getFreshnessDashboard,
  DEFAULT_MAX_CANDIDATES,
} = require("../surveillance/freshnessDashboard");
const {
  createFreshnessDashboardController,
  getFreshnessDashboardData,
} = require("../../server/controllers/freshnessDashboardController");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

const BULLETIN_URL = "https://example.test/bulletin.pdf";
const ADAPTER = {
  slug: "dashboard-test",
  name: "Dashboard Test Exam",
  bulletinUrls: [BULLETIN_URL],
};
const SNAPSHOT_BASELINE = {
  sourceUrl: BULLETIN_URL,
  documentUrl: BULLETIN_URL,
  contentHash: "baseline-hash",
  revision: false,
  evidenceExcerpts: [],
  value: null,
};
const SNAPSHOT_LATEST = {
  ...SNAPSHOT_BASELINE,
  contentHash: "latest-hash",
};

function candidateDoc(candidateId, overrides = {}) {
  return {
    candidateId,
    name: "Dashboard Test Exam",
    sourceUrl: "https://example.test/",
    sourceDomain: "example.test",
    discoverySource: "step25-test",
    discoveredAt: new Date("2026-01-01T00:00:00Z"),
    status: "DISCOVERED",
    ...overrides,
  };
}

function historyEntry(outcome, checkedAt, snapshot, triggers = []) {
  return { outcome, checkedAt: new Date(checkedAt), snapshot, triggers };
}

describe("STEP 25 — read-only freshness dashboard data", () => {
  let mongod;
  let mongoUri;
  let connection;
  let models;
  let writeCommands;
  let captureWrites;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("step25_dashboard"));
    connection = await mongoose.createConnection(mongoUri, { monitorCommands: true }).asPromise();
    models = {
      ExamCandidate: getExamCandidateModel(connection),
      SurveillanceState: getSurveillanceStateModel(connection),
      ReviewState: getReviewStateModel(connection),
      AllowlistDeclaration: getAllowlistDeclarationModel(connection),
    };
    writeCommands = [];
    captureWrites = false;
    connection.on("commandStarted", (event) => {
      if (captureWrites && ["insert", "update", "delete", "findAndModify", "bulkWrite"].includes(event.commandName)) {
        writeCommands.push(event.commandName);
      }
    });
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    const open = mongoose.connections.filter((item) => item.readyState === 1);
    assert.equal(open.length, 0, "dashboard tests must not leak connections");
  });

  beforeEach(async () => {
    captureWrites = false;
    writeCommands.length = 0;
    for (const model of Object.values(models)) await model.deleteMany({});
  });

  async function addCandidate(candidateId, overrides) {
    return models.ExamCandidate.create(candidateDoc(candidateId, overrides));
  }

  async function addState(candidateId, overrides = {}) {
    return models.SurveillanceState.create({
      candidateId,
      sourceUrl: BULLETIN_URL,
      sourceDomain: "example.test",
      baseline: SNAPSHOT_BASELINE,
      history: [
        historyEntry("BASELINE", "2026-02-01T00:00:00Z", SNAPSHOT_BASELINE),
        historyEntry("NO_ACTION", "2026-02-02T00:00:00Z", SNAPSHOT_LATEST),
      ],
      lastOutcome: "NO_ACTION",
      reviewStateKey: null,
      ...overrides,
    });
  }

  async function read(filters = {}) {
    return getFreshnessDashboard(filters, models, {
      resolveAdapter: async () => ADAPTER,
    });
  }

  it("1. returns an empty bounded result when no candidates exist", async () => {
    const result = await read();
    assert.deepEqual(result, {
      limit: DEFAULT_MAX_CANDIDATES,
      statusFilter: null,
      total: 0,
      results: [],
    });
  });

  it("2. reports a stable observation as NO_ACTION", async () => {
    await addCandidate("stable");
    await addState("stable");
    const result = await read({ candidateId: "stable" });
    assert.equal(result.results[0].freshnessStatus, "NO_ACTION");
    assert.equal(result.results[0].bulletins[0].freshnessStatus, "NO_ACTION");
  });

  it("3. reports REVIEW_REQUIRED and the persisted drift trigger", async () => {
    await addCandidate("review");
    await addState("review", {
      history: [
        historyEntry("BASELINE", "2026-02-01T00:00:00Z", SNAPSHOT_BASELINE),
        historyEntry("REVIEW_REQUIRED", "2026-02-03T00:00:00Z", SNAPSHOT_LATEST, ["content-changed"]),
      ],
      lastOutcome: "REVIEW_REQUIRED",
    });
    const result = await read({ candidateId: "review" });
    assert.equal(result.results[0].freshnessStatus, "REVIEW_REQUIRED");
    assert.deepEqual(result.results[0].bulletins[0].reasons, ["content-changed"]);
  });

  it("4. reports a failed freshness observation", async () => {
    await addCandidate("failed");
    await addState("failed", {
      baseline: null,
      history: [historyEntry("FAILED", "2026-02-04T00:00:00Z", null)],
      lastOutcome: "FAILED",
    });
    const result = await read({ candidateId: "failed" });
    assert.equal(result.results[0].freshnessStatus, "FAILED");
    assert.equal(result.results[0].bulletins[0].latestObservation.outcome, "FAILED");
  });

  it("5. exposes a retired declaration without treating it as active", async () => {
    await addCandidate("retired");
    await models.AllowlistDeclaration.create({
      adapterSlug: ADAPTER.slug,
      urls: [],
      retired: [BULLETIN_URL],
      resolutions: [{
        reviewId: `surveillance:retired::${BULLETIN_URL}`,
        candidateId: "retired",
        decision: "RETIRE",
        operator: "operator",
        oldUrl: BULLETIN_URL,
        newUrl: null,
        reason: "source retired",
        evidence: { source: "authority" },
        timestamp: new Date("2026-02-05T00:00:00Z"),
      }],
    });
    const result = await read({ candidateId: "retired" });
    const bulletin = result.results[0].bulletins[0];
    assert.equal(bulletin.declarationStatus, "retired");
    assert.equal(bulletin.resolutionHistory[0].decision, "RETIRE");
    assert.equal(result.results[0].freshnessStatus, null);
  });

  it("6. links the candidate freshness review state", async () => {
    await addCandidate("linked-review");
    await addState("linked-review", {
      history: [historyEntry("REVIEW_REQUIRED", "2026-02-06T00:00:00Z", SNAPSHOT_LATEST)],
      lastOutcome: "REVIEW_REQUIRED",
    });
    await models.ReviewState.create({
      draftId: "surveillance:linked-review",
      stage: "REVIEW_REQUIRED",
      decidedAt: new Date("2026-02-06T00:00:00Z"),
      items: [{
        field: `allowlist:${BULLETIN_URL}`,
        reviewStatus: "REVIEW_REQUIRED",
        reason: "operator should inspect bulletin",
      }],
    });
    const result = await read({ candidateId: "linked-review" });
    assert.equal(result.results[0].linkedReview.stage, "REVIEW_REQUIRED");
    assert.equal(result.results[0].bulletins[0].linkedReview.items[0].reason, "operator should inspect bulletin");
    assert.ok(result.results[0].reviewReasons.includes("operator should inspect bulletin"));
  });

  it("7. returns the stored baseline and latest observation timestamps", async () => {
    await addCandidate("snapshots");
    await addState("snapshots");
    const bulletin = (await read({ candidateId: "snapshots" })).results[0].bulletins[0];
    assert.equal(bulletin.baselineObservation.snapshot.contentHash, "baseline-hash");
    assert.equal(bulletin.baselineObservation.checkedAt, "2026-02-01T00:00:00.000Z");
    assert.equal(bulletin.latestObservation.snapshot.contentHash, "latest-hash");
    assert.equal(bulletin.latestObservation.checkedAt, "2026-02-02T00:00:00.000Z");
    assert.equal(bulletin.historyCount, 2);
  });

  it("8. rejects an oversized limit at the operations-layer cap", async () => {
    await assert.rejects(
      read({ limit: DEFAULT_MAX_CANDIDATES + 1 }),
      new RegExp(`limit must not exceed ${DEFAULT_MAX_CANDIDATES}`)
    );
  });

  it("9. selects only the requested candidate ID", async () => {
    await addCandidate("requested");
    await addCandidate("not-requested");
    const result = await read({ candidateId: "requested" });
    assert.deepEqual(result.results.map((entry) => entry.candidate.candidateId), ["requested"]);
  });

  it("10. filters candidates by aggregate freshness status", async () => {
    await addCandidate("status-stable");
    await addState("status-stable");
    await addCandidate("status-review");
    await addState("status-review", {
      history: [historyEntry("REVIEW_REQUIRED", "2026-02-07T00:00:00Z", SNAPSHOT_LATEST)],
      lastOutcome: "REVIEW_REQUIRED",
    });
    const result = await read({ limit: 5, status: "REVIEW_REQUIRED" });
    assert.deepEqual(result.results.map((entry) => entry.candidate.candidateId), ["status-review"]);
  });

  it("10a. applies the status filter before the requested result limit", async () => {
    await addCandidate("status-stable-first");
    await addState("status-stable-first");
    await addCandidate("status-review-after-limit");
    await addState("status-review-after-limit", {
      history: [historyEntry("REVIEW_REQUIRED", "2026-02-07T00:00:00Z", SNAPSHOT_LATEST)],
      lastOutcome: "REVIEW_REQUIRED",
    });

    const result = await read({ limit: 1, status: "REVIEW_REQUIRED" });
    assert.deepEqual(
      result.results.map((entry) => entry.candidate.candidateId),
      ["status-review-after-limit"]
    );
  });

  it("11. returns deterministic output across repeated reads", async () => {
    await addCandidate("deterministic");
    await addState("deterministic");
    const first = await read({ candidateId: "deterministic" });
    const second = await read({ candidateId: "deterministic" });
    assert.deepEqual(second, first);
  });

  it("12. performs zero database writes", async () => {
    await addCandidate("no-writes");
    await addState("no-writes");
    captureWrites = true;
    await read({ candidateId: "no-writes" });
    captureWrites = false;
    assert.deepEqual(writeCommands, []);
  });

  it("13. serves the API response and rejects invalid endpoint filters", async () => {
    await addCandidate("api-candidate", { name: "JEE Main" });
    const handler = createFreshnessDashboardController(connection);
    const response = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    await handler({ query: { candidateId: "api-candidate" } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.results[0].candidate.adapterSlug, "jee-main");
    assert.equal(response.body.results[0].bulletins[0].declarationStatus, "active");

    const invalidResponse = { ...response, body: null };
    await handler({ query: { limit: "nope" } }, invalidResponse);
    assert.equal(invalidResponse.statusCode, 400);
    assert.equal(invalidResponse.body.success, false);

    const freshConnection = await mongoose.createConnection(mongoUri, {
      monitorCommands: true,
    }).asPromise();
    const databaseWrites = [];
    freshConnection.on("commandStarted", (event) => {
      if (["create", "createIndexes", "insert", "update", "delete", "findAndModify"].includes(event.commandName)) {
        databaseWrites.push(event.commandName);
      }
    });
    await getFreshnessDashboardData({ candidateId: "api-candidate" }, freshConnection);
    await freshConnection.close();
    assert.deepEqual(databaseWrites, [], "first API model use must not create collections or indexes");
  });

  it("rejects invalid filters and refuses production models", async () => {
    await assert.rejects(read({ limit: 0 }), /limit must be a positive integer/);
    await assert.rejects(read({ status: "UNKNOWN" }), /status must be one of/);
    await assert.rejects(read({ candidateId: " " }), /candidateId must be a non-empty string/);
    await assert.rejects(
      getFreshnessDashboard({}, { ...models, ExamModel: {} }),
      /production models are refused/
    );
  });
});
