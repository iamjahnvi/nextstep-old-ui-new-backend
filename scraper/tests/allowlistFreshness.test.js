// =============================================================================
// scraper/tests/allowlistFreshness.test.js
// =============================================================================
// WHAT: STEP 23 tests — freshness monitoring for adapter-declared bulletin
//   URLs: baselines, stable re-checks, content/redirect/validity changes,
//   unreachable handling, append-only history across runs, bounded selection,
//   adapter non-mutation, fetch confinement to declared URLs, and the
//   no-publish boundary.
// WHY: Declared CDN bulletin URLs rot. Freshness must notice and route to
//   human review — never rewrite the adapter, never discover a replacement,
//   never publish.
// DB: isolated mongodb-memory-server only; MONGO_URI unset. All fetches are
//   injected stubs — never live sites. Cross-restart durability itself is
//   proven live against persistent MongoDB in STEP23_REPORT.md (memory-server
//   restarts are lossy on Windows by environment, not by code).
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
const {
  DEFAULT_MAX_CANDIDATES,
  sizeBand,
  declaredUrlsOf,
  observeAllowlistUrl,
  checkAllowlistFreshness,
  runAllowlistFreshness,
} = require("../surveillance/allowlistFreshness");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

const PDF_V1 = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("version-one-body")]);
const PDF_V2 = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("version-two-body!!")]);
const GARBAGE = Buffer.from("not a pdf at all, just text");

function candidateDoc(id, overrides = {}) {
  return {
    candidateId: id,
    name: `Candidate ${id}`,
    sourceUrl: "http://127.0.0.1/",
    sourceDomain: "127.0.0.1",
    discoverySource: "step23-test-seed",
    discoveredAt: new Date("2026-01-01T00:00:00Z"),
    status: "DISCOVERED",
    ...overrides,
  };
}

function staticAdapter(urls) {
  return { slug: "step23-exam", render: "static", bulletinUrls: urls, docRules: [] };
}

// Programmable stub transport: responses keyed by URL, every call recorded.
function stubTransport(responses, calls) {
  return async (meta) => {
    calls.push(meta.url);
    if (!Object.prototype.hasOwnProperty.call(responses, meta.url)) {
      throw new Error(`fetch failed: no stub for ${meta.url}`);
    }
    const hit = responses[meta.url];
    if (hit.error) throw new Error(hit.error);
    return {
      label: meta.label,
      url: hit.finalUrl || meta.url,
      sourceUrl: meta.sourceUrl,
      type: hit.type || "PDF",
      fetchedAt: new Date("2026-01-02T00:00:00Z"),
      status: hit.status || 200,
      contentType: hit.contentType,
      content: hit.content,
    };
  };
}

describe("STEP 23 — allowlist freshness observation", () => {
  let mongod;
  let mongoUri;
  let connection;
  let models;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("step23_freshness"));
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
    assert.equal(open.length, 0, "freshness must not leak connections");
  });

  async function reset() {
    for (const model of Object.values(models)) await model.deleteMany({});
  }

  it("1. stable URL baselines then re-checks NO_ACTION with history", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-stable-1"));
    const calls = [];
    const opts = {
      adapter: staticAdapter(["http://127.0.0.1/bulletin.pdf"]),
      fetchDocument: stubTransport({ "http://127.0.0.1/bulletin.pdf": { contentType: "application/pdf", content: PDF_V1 } }, calls),
    };
    const first = await checkAllowlistFreshness("dsc-stable-1", models, opts);
    assert.equal(first.driftStatus, "NO_ACTION");
    assert.equal(first.baselineEstablished, true);
    assert.equal(first.reviewRequired, false);
    assert.ok(first.urls[0].contentHash);
    assert.equal(first.urls[0].outcome, "NO_ACTION");

    const second = await checkAllowlistFreshness("dsc-stable-1", models, opts);
    assert.equal(second.driftStatus, "NO_ACTION");
    assert.deepEqual(second.driftTriggers, []);
    assert.equal(second.baselineEstablished, false);
    const state = await models.SurveillanceState.findOne({ candidateId: "dsc-stable-1", sourceUrl: "http://127.0.0.1/bulletin.pdf" }).lean();
    assert.ok(state);
    assert.equal(state.history.length, 2);
    assert.equal(state.baseline.contentHash, second.urls[0].contentHash);
  });

  it("2. changed content triggers REVIEW_REQUIRED with evidence", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-change-1"));
    const stable = {
      adapter: staticAdapter(["http://127.0.0.1/bulletin.pdf"]),
      fetchDocument: stubTransport({ "http://127.0.0.1/bulletin.pdf": { contentType: "application/pdf", content: PDF_V1 } }, []),
    };
    await checkAllowlistFreshness("dsc-change-1", models, stable);
    const changed = await checkAllowlistFreshness("dsc-change-1", models, {
      adapter: staticAdapter(["http://127.0.0.1/bulletin.pdf"]),
      fetchDocument: stubTransport({ "http://127.0.0.1/bulletin.pdf": { contentType: "application/pdf", content: PDF_V2 } }, []),
    });
    assert.equal(changed.driftStatus, "REVIEW_REQUIRED");
    assert.ok(changed.driftTriggers.includes("content-changed"));
    assert.equal(changed.reviewRequired, true);
    assert.equal(changed.reviewStateKey, "surveillance:dsc-change-1");
    const review = await models.ReviewState.findOne({ draftId: "surveillance:dsc-change-1" }).lean();
    assert.ok(review);
    assert.equal(review.stage, "REVIEW_REQUIRED");
    assert.equal(review.items.length, 1);
    assert.equal(review.items[0].field, "allowlist:http://127.0.0.1/bulletin.pdf");
    assert.equal(review.items[0].reviewStatus, "REVIEW_REQUIRED");
  });

  it("3. unreachable-after-working reviews; unreachable-at-baseline fails", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-flap-1"));
    const working = {
      adapter: staticAdapter(["http://127.0.0.1/bulletin.pdf"]),
      fetchDocument: stubTransport({ "http://127.0.0.1/bulletin.pdf": { contentType: "application/pdf", content: PDF_V1 } }, []),
    };
    await checkAllowlistFreshness("dsc-flap-1", models, working);
    const down = await checkAllowlistFreshness("dsc-flap-1", models, {
      adapter: staticAdapter(["http://127.0.0.1/bulletin.pdf"]),
      fetchDocument: async () => {
        throw new Error("connection refused");
      },
    });
    assert.equal(down.driftStatus, "REVIEW_REQUIRED");
    assert.match(down.urls[0].reason, /previously reachable, now failing/);

    await models.ExamCandidate.create(candidateDoc("dsc-down-1"));
    const neverUp = await checkAllowlistFreshness("dsc-down-1", models, {
      adapter: staticAdapter(["http://127.0.0.1/bulletin.pdf"]),
      fetchDocument: async () => {
        throw new Error("connection refused");
      },
    });
    assert.equal(neverUp.driftStatus, "FAILED");
    assert.match(neverUp.urls[0].reason, /fetch failed/);
  });

  it("4. redirects and invalidated documents trigger review with evidence", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-redir-1"));
    const stableOpts = {
      adapter: staticAdapter(["http://127.0.0.1/bulletin.pdf"]),
      fetchDocument: stubTransport({ "http://127.0.0.1/bulletin.pdf": { contentType: "application/pdf", content: PDF_V1 } }, []),
    };
    await checkAllowlistFreshness("dsc-redir-1", models, stableOpts);
    const moved = await checkAllowlistFreshness("dsc-redir-1", models, {
      adapter: staticAdapter(["http://127.0.0.1/bulletin.pdf"]),
      fetchDocument: stubTransport({
        "http://127.0.0.1/bulletin.pdf": { contentType: "application/pdf", content: PDF_V1, finalUrl: "http://127.0.0.1/relocated.pdf" },
      }, []),
    });
    assert.equal(moved.driftStatus, "REVIEW_REQUIRED");
    assert.ok(moved.driftTriggers.includes("redirect-detected"));
    assert.equal(moved.urls[0].redirectDetected, true);
    assert.equal(moved.urls[0].finalUrl, "http://127.0.0.1/relocated.pdf");

    await models.ExamCandidate.create(candidateDoc("dsc-rot-1"));
    await checkAllowlistFreshness("dsc-rot-1", models, stableOpts);
    const rotted = await checkAllowlistFreshness("dsc-rot-1", models, {
      adapter: staticAdapter(["http://127.0.0.1/bulletin.pdf"]),
      fetchDocument: stubTransport({ "http://127.0.0.1/bulletin.pdf": { contentType: "text/html", content: GARBAGE } }, []),
    });
    assert.equal(rotted.driftStatus, "REVIEW_REQUIRED");
  });

  it("5. bounds, determinism, and non-mutation hold", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-bound-1"));
    const urls = Array.from({ length: 8 }, (_, i) => `http://127.0.0.1/${i}.pdf`);
    const byUrl = Object.fromEntries(urls.map((url) => [url, { contentType: "application/pdf", content: PDF_V1 }]));
    const calls = [];
    const adapter = staticAdapter(urls);
    const snapshot = JSON.parse(JSON.stringify(adapter));
    const out = await checkAllowlistFreshness("dsc-bound-1", models, {
      adapter,
      fetchDocument: stubFetchCollect(byUrl, calls),
    });
    assert.ok(out.urls.length <= 5);
    assert.equal(calls.length, out.urls.length);
    assert.deepEqual(adapter, snapshot, "adapter must never be mutated");
    assert.ok(calls.every((url) => urls.includes(url)), "only declared URLs are fetched");
    assert.equal(declaredUrlsOf(adapter).length, 5);

      function stubFetchCollect(map, log) {
      return stubTransport(map, log);
    }
  });

  it("6. dry-run compares without writing; unknown candidates fail closed", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-dry-1"));
    const calls = [];
    const opts = {
      adapter: staticAdapter(["http://127.0.0.1/bulletin.pdf"]),
      fetchDocument: stubTransport({ "http://127.0.0.1/bulletin.pdf": { contentType: "application/pdf", content: PDF_V1 } }, calls),
      persist: false,
    };
    const out = await checkAllowlistFreshness("dsc-dry-1", models, opts);
    assert.equal(out.baselineEstablished, true);
    assert.equal(calls.length, 1);
    assert.equal(await models.SurveillanceState.countDocuments({}), 0);
    assert.equal(await models.ReviewState.countDocuments({}), 0);

    const missing = await checkAllowlistFreshness("dsc-missing", models, opts);
    assert.equal(missing.driftStatus, "FAILED");
    assert.match(missing.error, /candidate not found/);
  });

  it("7. batch selection isolates failures and respects bounds", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-ok-1"));
    await models.ExamCandidate.create(candidateDoc("dsc-ok-2"));
    const opts = {
      adapter: staticAdapter(["http://127.0.0.1/bulletin.pdf"]),
      fetchDocument: stubTransport({ "http://127.0.0.1/bulletin.pdf": { contentType: "application/pdf", content: PDF_V1 } }, []),
    };
    const summary = await runAllowlistFreshness({ candidateIds: ["dsc-ok-1", "dsc-missing", "dsc-ok-2"] }, models, opts);
    assert.equal(summary.total, 3);
    assert.equal(summary.noAction, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.reviewRequired, 0);
    await assert.rejects(runAllowlistFreshness({ candidateIds: [] }, models, opts), /empty candidate selection/);
    await assert.rejects(
      runAllowlistFreshness({ candidateIds: ["dsc-ok-1", "dsc-ok-2"] }, models, { ...opts, maxCandidates: 1 }),
      /maxCandidates/
    );
    const limited = await runAllowlistFreshness({ limit: 1 }, models, opts);
    assert.equal(limited.total, 1);
  });

  it("8. size bands and observation shape are deterministic", async () => {
    assert.equal(sizeBand(0), "tiny");
    assert.equal(sizeBand(50000), "small");
    assert.equal(sizeBand(500000), "medium");
    assert.equal(sizeBand(5000000), "large");
    assert.equal(sizeBand(50000000), "huge");
    const obs = await observeAllowlistUrl({
      declaredUrl: "http://127.0.0.1/bulletin.pdf",
      source: { sourceUrl: "http://127.0.0.1/" },
      adapter: staticAdapter(["http://127.0.0.1/bulletin.pdf"]),
      options: {
        fetchDocument: stubTransport({ "http://127.0.0.1/bulletin.pdf": { contentType: "application/pdf", content: PDF_V1 } }, []),
        now: new Date("2026-01-03T00:00:00Z"),
      },
    });
    assert.equal(obs.reachable, true);
    assert.equal(obs.accepted, true);
    assert.equal(obs.redirectDetected, false);
    assert.equal(obs.documentType, "PDF");
    assert.equal(obs.byteLength, PDF_V1.length);
    assert.equal(typeof obs.contentHash, "string");
    assert.equal(obs.observedAt, new Date("2026-01-03T00:00:00Z").toISOString());
    await assert.rejects(observeAllowlistUrl({}), /declaredUrl is required/);
  });

  it("9. freshness publishes nothing, mutates nothing, names no exams", async () => {
    await reset();
    const before = await models.ExamCandidate.create(candidateDoc("dsc-safe-1"));
    await checkAllowlistFreshness("dsc-safe-1", models, {
      adapter: staticAdapter([]),
    });
    const after = await models.ExamCandidate.findOne({ candidateId: "dsc-safe-1" }).lean();
    assert.equal(after.status, "DISCOVERED");
    assert.deepEqual(
      { name: after.name, sourceUrl: after.sourceUrl, conductingBody: after.conductingBody },
      { name: before.name, sourceUrl: before.sourceUrl, conductingBody: before.conductingBody }
    );
    await assert.rejects(
      checkAllowlistFreshness("dsc-safe-1", { ...models, ExamModel: {} }, { adapter: staticAdapter([]) }),
      /production models are refused/
    );
    for (const relative of ["surveillance/allowlistFreshness.js"]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      assert.ok(!/require\(["'].*publish[^"']*["']\)/.test(code), `${relative}: no publish imports`);
      assert.ok(!/publishVerifiedDraft|confirmPublish|dryRunPublish/.test(code.replace(/\/\/.*$/gm, "")), `${relative}: no publish calls`);
      assert.ok(!/updateOne|updateMany|deleteOne|deleteMany|findOneAndUpdate/.test(code.replace(/\/\/.*$/gm, "")), `${relative}: no modifying writes`);
      const executable = code
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
        .replace(/\/\/.*$/gm, "");
      assert.ok(!/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable), `${relative}: no exam names`);
    }
    assert.equal(DEFAULT_MAX_CANDIDATES, 5);
    assert.equal(SURVEILLANCE_STATE_COLLECTION, "scraper_surveillance_states");
  });
});
