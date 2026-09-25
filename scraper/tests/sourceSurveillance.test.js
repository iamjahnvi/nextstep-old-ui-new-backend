// =============================================================================
// scraper/tests/sourceSurveillance.test.js
// =============================================================================
// WHAT: STEP 12 tests — source surveillance (baseline → re-check → NO_ACTION
//   / REVIEW_REQUIRED / FAILED), append-only history, Step 8 review triggers,
//   bounded selection, scheduler plans, CLI parsing, and the no-publish /
//   no-auto-modify boundaries.
// WHY: Sources move under us; surveillance must notice, preserve both sides,
//   and route to human review — never rewrite exam data, never publish.
// DB: isolated mongodb-memory-server only; MONGO_URI unset. All fetches are
//   injected stubs — never live sites.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");

const { getExamCandidateModel } = require("../models/examCandidate");
const { getSurveillanceStateModel, SURVEILLANCE_STATE_COLLECTION } = require("../models/surveillanceState");
const { getReviewStateModel } = require("../models/reviewState");
const { checkCandidateSource, runSurveillanceChecks } = require("../surveillance/sourceSurveillance");
const { createSurveillancePlan, runPlan, describePlan } = require("../surveillance/surveillanceScheduler");
const { parseArgs } = require("../cli/surveillance");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

const NOW = new Date("2026-09-24T00:00:00Z");
const VOLATILE_KEYS = new Set(["checkedAt", "decidedAt", "createdAt", "updatedAt", "_id", "id", "durationMs"]);

function projection(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => (VOLATILE_KEYS.has(key) ? undefined : item)));
}

function candidateDoc(id, url) {
  return {
    candidateId: id,
    name: `Watch ${id}`,
    description: null,
    conductingBody: null,
    examUrl: null,
    edition: null,
    year: null,
    sourceUrl: url,
    sourceDomain: "127.0.0.1",
    discoverySource: "step12-test-seed",
    discoverySources: ["step12-test-seed"],
    discoveredAt: NOW,
    lastSeenAt: NOW,
    status: "DISCOVERED",
    evidence: [],
  };
}

function stubFetch(bytesByUrl, finalUrl) {
  return async (url) => {
    if (!(url in bytesByUrl)) throw new Error(`fetch failed for ${url}`);
    return { url: finalUrl || url, content: bytesByUrl[url] };
  };
}

describe("STEP 12 — surveillance checks", () => {
  let mongod;
  let mongoUri;
  let connection;
  let models;
  let savedMongoUri;

  const deps = () => ({
    ExamCandidate: models.ExamCandidate,
    SurveillanceState: models.SurveillanceState,
    ReviewState: models.ReviewState,
  });

  const opts = (extra = {}) => ({
    fetchContent: stubFetch({ "http://127.0.0.1/page.html": Buffer.from("version-one") }),
    persist: true,
    now: () => new Date(NOW),
    ...extra,
  });

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("step12_surveillance"));
    connection = await mongoose.createConnection(mongoUri).asPromise();
    models = {
      ExamCandidate: getExamCandidateModel(connection),
      SurveillanceState: getSurveillanceStateModel(connection),
      ReviewState: getReviewStateModel(connection),
    };
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0, "surveillance must not leak connections");
  });

  async function reset() {
    for (const model of [models.ExamCandidate, models.SurveillanceState, models.ReviewState]) {
      await model.deleteMany({});
    }
  }

  it("1. first check establishes the baseline without review", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-watch-1", "http://127.0.0.1/page.html"));
    const out = await checkCandidateSource("dsc-watch-1", deps(), opts());
    assert.equal(out.driftStatus, "NO_ACTION");
    assert.equal(out.baselineEstablished, true);
    assert.equal(out.reviewRequired, false);
    assert.equal(out.reviewStateKey, null);
    assert.ok(out.currentSnapshot.contentHash);
    const state = await models.SurveillanceState.findOne({ candidateId: "dsc-watch-1" }).lean();
    assert.ok(state);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].outcome, "BASELINE");
    assert.equal(await models.ReviewState.countDocuments({}), 0);
  });

  it("2. identical content re-checks to NO_ACTION with growing history", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-watch-1", "http://127.0.0.1/page.html"));
    await checkCandidateSource("dsc-watch-1", deps(), opts());
    const out = await checkCandidateSource("dsc-watch-1", deps(), opts());
    assert.equal(out.driftStatus, "NO_ACTION");
    assert.equal(out.baselineEstablished, false);
    assert.deepEqual(out.driftTriggers, []);
    const state = await models.SurveillanceState.findOne({ candidateId: "dsc-watch-1" }).lean();
    assert.equal(state.history.length, 2);
    assert.equal(state.history[1].outcome, "NO_ACTION");
    assert.equal(state.baseline.contentHash, out.currentSnapshot.contentHash);
  });

  it("3. content hash change triggers REVIEW_REQUIRED with review state", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-watch-1", "http://127.0.0.1/page.html"));
    await checkCandidateSource("dsc-watch-1", deps(), opts());
    const out = await checkCandidateSource(
      "dsc-watch-1",
      deps(),
      opts({ fetchContent: stubFetch({ "http://127.0.0.1/page.html": Buffer.from("version-two") }) })
    );
    assert.equal(out.driftStatus, "REVIEW_REQUIRED");
    assert.ok(out.driftTriggers.includes("content-changed"));
    assert.equal(out.reviewRequired, true);
    assert.equal(out.reviewStateKey, "surveillance:dsc-watch-1");
    const review = await models.ReviewState.findOne({ draftId: "surveillance:dsc-watch-1" }).lean();
    assert.ok(review);
    assert.equal(review.stage, "REVIEW_REQUIRED");
    assert.equal(review.items.length, 1);
    assert.ok(review.items[0].reason.includes("content-changed"));
    assert.deepEqual(review.items[0].sourceDocuments, ["http://127.0.0.1/page.html"]);
  });

  it("4. moved source, new revision, lost evidence, and changed value trigger review", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-watch-1", "http://127.0.0.1/page.html"));
    await checkCandidateSource(
      "dsc-watch-1",
      deps(),
      opts({ observe: { evidenceExcerpts: ["Class 12 required"], value: "2026-01-10" } })
    );
    const moved = await checkCandidateSource(
      "dsc-watch-1",
      deps(),
      opts({ fetchContent: stubFetch({ "http://127.0.0.1/page.html": Buffer.from("version-one") }, "http://127.0.0.1/v2.html") })
    );
    assert.ok(moved.driftTriggers.includes("source-changed"));

    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-watch-1", "http://127.0.0.1/page.html"));
    await checkCandidateSource("dsc-watch-1", deps(), opts());
    const revised = await checkCandidateSource(
      "dsc-watch-1",
      deps(),
      opts({ observe: { revision: true } })
    );
    assert.ok(revised.driftTriggers.includes("revision-changed"));

    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-watch-1", "http://127.0.0.1/page.html"));
    await checkCandidateSource(
      "dsc-watch-1",
      deps(),
      opts({ observe: { evidenceExcerpts: ["Class 12 required"] } })
    );
    const removed = await checkCandidateSource(
      "dsc-watch-1",
      deps(),
      opts({ observe: { evidenceExcerpts: ["something else entirely"] } })
    );
    assert.ok(removed.driftTriggers.includes("evidence-removed"));

    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-watch-1", "http://127.0.0.1/page.html"));
    await checkCandidateSource(
      "dsc-watch-1",
      deps(),
      opts({ observe: { value: "2026-01-10" } })
    );
    const changed = await checkCandidateSource(
      "dsc-watch-1",
      deps(),
      opts({ observe: { value: "2026-01-15" } })
    );
    assert.ok(changed.driftTriggers.includes("value-changed"));
    for (const out of [moved, revised, removed, changed]) {
      assert.equal(out.driftStatus, "REVIEW_REQUIRED");
    }
  });

  it("5. failed fetch records FAILED without fabricating snapshots", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-watch-1", "http://127.0.0.1/page.html"));
    await checkCandidateSource("dsc-watch-1", deps(), opts());
    const out = await checkCandidateSource(
      "dsc-watch-1",
      deps(),
      opts({ fetchContent: async () => { throw new Error("connection refused"); } })
    );
    assert.equal(out.driftStatus, "FAILED");
    assert.match(out.error, /connection refused/);
    assert.equal(out.currentSnapshot, null);
    assert.equal(out.reviewRequired, false);
  });

  it("6. history is append-only across runs", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-watch-1", "http://127.0.0.1/page.html"));
    const first = await checkCandidateSource("dsc-watch-1", deps(), opts());
    const second = await checkCandidateSource(
      "dsc-watch-1",
      deps(),
      opts({ fetchContent: stubFetch({ "http://127.0.0.1/page.html": Buffer.from("version-two") }) })
    );
    const state = await models.SurveillanceState.findOne({ candidateId: "dsc-watch-1" }).lean();
    assert.equal(state.history.length, 2);
    assert.equal(state.history[0].snapshot.contentHash, first.currentSnapshot.contentHash);
    assert.equal(state.history[1].snapshot.contentHash, second.currentSnapshot.contentHash);
    assert.notEqual(state.history[0].snapshot.contentHash, state.history[1].snapshot.contentHash);
    assert.equal(state.baseline.contentHash, first.currentSnapshot.contentHash);
  });

  it("7. twin candidates decide identically (determinism)", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-twin-a", "http://127.0.0.1/a.html"));
    await models.ExamCandidate.create(candidateDoc("dsc-twin-b", "http://127.0.0.1/b.html"));
    const fetchBoth = stubFetch({
      "http://127.0.0.1/a.html": Buffer.from("same-bytes"),
      "http://127.0.0.1/b.html": Buffer.from("same-bytes"),
    });
    const a = projection(await checkCandidateSource("dsc-twin-a", deps(), opts({ fetchContent: fetchBoth })));
    const b = projection(await checkCandidateSource("dsc-twin-b", deps(), opts({ fetchContent: fetchBoth })));
    for (const twin of [a, b]) {
      delete twin.candidateId;
      delete twin.examName;
      delete twin.sourceUrl;
      delete twin.currentSnapshot.sourceUrl;
      delete twin.currentSnapshot.documentUrl;
    }
    assert.deepEqual(a, b);
  });

  it("8. one failure never stops the batch", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-ok", "http://127.0.0.1/ok.html"));
    await models.ExamCandidate.create(candidateDoc("dsc-bad", "http://127.0.0.1/bad.html"));
    await models.ExamCandidate.create(candidateDoc("dsc-drift", "http://127.0.0.1/drift.html"));
    const fetchMixed = async (url) => {
      if (url === "http://127.0.0.1/bad.html") throw new Error("timeout");
      if (url === "http://127.0.0.1/ok.html") return { url, content: Buffer.from("steady") };
      return { url, content: Buffer.from("v1") };
    };
    // Baseline all three first.
    await runSurveillanceChecks(
      { candidateIds: ["dsc-ok", "dsc-bad", "dsc-drift"] },
      deps(),
      { fetchContent: fetchMixed, persist: true, now: () => new Date(NOW) }
    );
    const summary = await runSurveillanceChecks(
      { candidateIds: ["dsc-ok", "dsc-bad", "dsc-drift"] },
      deps(),
      {
        fetchContent: async (url) => {
          if (url === "http://127.0.0.1/bad.html") throw new Error("timeout");
          if (url === "http://127.0.0.1/ok.html") return { url, content: Buffer.from("steady") };
          return { url, content: Buffer.from("v2") };
        },
        persist: true,
        now: () => new Date(NOW),
      }
    );
    assert.equal(summary.total, 3);
    const byId = Object.fromEntries(summary.results.map((r) => [r.candidateId, r]));
    assert.equal(byId["dsc-ok"].driftStatus, "NO_ACTION");
    assert.equal(byId["dsc-bad"].driftStatus, "FAILED");
    assert.equal(byId["dsc-drift"].driftStatus, "REVIEW_REQUIRED");
    assert.equal(summary.noAction, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.reviewRequired, 1);
  });

  it("9. selection is explicit and bounded", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-1", "http://127.0.0.1/1.html"));
    await models.ExamCandidate.create(candidateDoc("dsc-2", "http://127.0.0.1/2.html"));
    await assert.rejects(runSurveillanceChecks({ candidateIds: [] }, deps(), opts()), /empty candidate selection/);
    await assert.rejects(
      runSurveillanceChecks({ candidateIds: ["dsc-1", "dsc-2"] }, deps(), { ...opts(), maxCandidates: 1 }),
      /maxCandidates/
    );
    const limited = await runSurveillanceChecks({ limit: 1 }, deps(), opts());
    assert.equal(limited.total, 1);
    const unknown = await runSurveillanceChecks({ candidateIds: ["dsc-missing"] }, deps(), opts());
    assert.equal(unknown.results[0].driftStatus, "FAILED");
  });

  it("10. dry-run writes nothing anywhere", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-watch-1", "http://127.0.0.1/page.html"));
    const before = await models.ExamCandidate.findOne({ candidateId: "dsc-watch-1" }).lean();
    const out = await checkCandidateSource("dsc-watch-1", deps(), opts({ persist: false }));
    assert.equal(out.baselineEstablished, true);
    assert.equal(await models.SurveillanceState.countDocuments({}), 0);
    assert.equal(await models.ReviewState.countDocuments({}), 0);
    assert.deepEqual(projection(await models.ExamCandidate.findOne({ candidateId: "dsc-watch-1" }).lean()), projection(before));
  });

  it("11. Step 8 drift semantics are reused, not duplicated", () => {
    const code = fs.readFileSync(path.join(__dirname, "..", "surveillance", "sourceSurveillance.js"), "utf8");
    assert.ok(/require\(["']\.\.\/review\/driftReview["']\)/.test(code), "reuses compareForDrift");
    assert.ok(/require\(["']\.\.\/review\/reviewDecision["']\)/.test(code), "reuses review decisions");
    assert.ok(!/function compareForDrift/.test(code), "no local drift reimplementation");
  });

  it("12. scheduler plans are bounded, timeless, and runnable", async () => {
    const plan = createSurveillancePlan({ candidateIds: ["dsc-a", "dsc-a", "dsc-b"], label: "nightly" });
    assert.deepEqual(plan.jobs, [{ candidateId: "dsc-a" }, { candidateId: "dsc-b" }]);
    assert.ok(plan.intervalMs >= 60000);
    assert.ok(describePlan(plan).length === 2);
    assert.throws(() => createSurveillancePlan({}), /candidateIds or limit/);
    assert.throws(() => createSurveillancePlan({ candidateIds: [] }), /empty/);
    assert.throws(() => createSurveillancePlan({ candidateIds: ["a", "b"], maxCandidates: 1 }), /maxCandidates/);

    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-a", "http://127.0.0.1/a.html"));
    const summary = await runPlan(plan, deps(), opts({
      fetchContent: stubFetch({
        "http://127.0.0.1/a.html": Buffer.from("plan-bytes"),
        "http://127.0.0.1/b.html": Buffer.from("plan-bytes"),
      }),
    }));
    // dsc-b has no candidate record: FAILED entry, plan still completes.
    assert.equal(summary.total, 2);
    assert.equal(summary.results[1].driftStatus, "FAILED");
  });

  it("13. CLI parses bounded dry-run selection and refuses writers", () => {
    const ids = parseArgs(["--candidate", "dsc-a", "--candidate", "dsc-b", "--dry-run"]);
    assert.deepEqual(ids.candidateIds, ["dsc-a", "dsc-b"]);
    assert.equal(ids.dryRun, true);
    assert.equal(ids.persist, false);
    const persisted = parseArgs(["--limit", "5", "--persist"]);
    assert.equal(persisted.limit, 5);
    assert.equal(persisted.persist, true);
    assert.equal(parseArgs(["--limit", "5", "--persist", "--dry-run"]).persist, false);
    assert.throws(() => parseArgs([]), /empty candidate selection/);
    assert.throws(() => parseArgs(["--candidate", "dsc-a", "--limit", "2"]), /cannot be combined/);
    assert.throws(() => parseArgs(["--candidate", "dsc-a", "--confirm"]), /never publishes/);
    assert.throws(() => parseArgs(["--candidate", "dsc-a", "--publish"]), /never publishes/);
    assert.throws(() => parseArgs(["--candidate", "dsc-a", "--accept"]), /never publishes/);
    assert.throws(() => parseArgs(["--limit", "0"]), /positive integer/);
  });

  it("14. surveillance publishes nothing, modifies nothing, names no exams", () => {
    for (const relative of [
      "surveillance/sourceSurveillance.js",
      "surveillance/surveillanceScheduler.js",
      "cli/surveillance.js",
      "models/surveillanceState.js",
    ]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      assert.ok(!/require\(["'].*publish[^"']*["']\)/.test(code), `${relative}: no publish imports`);
      assert.ok(!/publishVerifiedDraft|confirmPublish|dryRunPublish/.test(code.replace(/\/\/.*$/gm, "")), `${relative}: no publish calls`);
      assert.ok(!/ExamModel\.create|\.updateOne|\.updateMany|\.deleteOne|\.deleteMany|\.findOneAndUpdate/.test(code.replace(/\/\/.*$/gm, "")), `${relative}: no modifying writes`);
      const executable = code
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
        .replace(/\/\/.*$/gm, "");
      assert.ok(!/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable), `${relative}: no exam names`);
    }
    assert.equal(SURVEILLANCE_STATE_COLLECTION, "scraper_surveillance_states");
  });
});
