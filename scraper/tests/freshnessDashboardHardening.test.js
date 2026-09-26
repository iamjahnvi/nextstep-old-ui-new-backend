const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  DashboardRequestError,
  DEFAULT_MAX_CANDIDATES,
  normalizeFilters,
} = require("../surveillance/freshnessDashboard");
const {
  createFreshnessDashboardController,
  parseQuery,
} = require("../../server/controllers/freshnessDashboardController");

describe("STEP 29 — freshness dashboard production hardening", () => {
  it("accepts valid filters and rejects invalid or oversized values", () => {
    assert.deepEqual(normalizeFilters({
      candidateId: " candidate-1 ",
      status: "FAILED",
      limit: 2,
    }), {
      candidateId: "candidate-1",
      status: "FAILED",
      limit: 2,
    });
    assert.deepEqual(parseQuery({
      candidateId: "candidate-1",
      status: "FAILED",
      limit: "2",
    }), {
      candidateId: "candidate-1",
      status: "FAILED",
      limit: 2,
    });
    assert.throws(() => normalizeFilters({ candidateId: " " }), DashboardRequestError);
    assert.throws(() => normalizeFilters({ status: "UNKNOWN" }), /status must be one of/);
    assert.throws(() => normalizeFilters({ limit: 0 }), /positive integer/);
    assert.throws(
      () => normalizeFilters({ limit: DEFAULT_MAX_CANDIDATES + 1 }),
      new RegExp(`limit must not exceed ${DEFAULT_MAX_CANDIDATES}`)
    );
    assert.throws(() => parseQuery({ limit: "2.5" }), /positive integer/);
  });

  it("returns the existing safe error format for database/read failures", async () => {
    const handler = createFreshnessDashboardController({
      model() {
        throw new Error("sensitive database connection details");
      },
    });
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

    const originalConsoleError = console.error;
    const logMessages = [];
    console.error = (message) => logMessages.push(message);
    try {
      await handler({ query: {} }, response);
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, {
      success: false,
      message: "Unable to load freshness dashboard data",
    });
    assert.doesNotMatch(JSON.stringify(response.body), /sensitive|database|connection details/i);
    assert.deepEqual(logMessages, ["Freshness dashboard request failed"]);
  });
});
