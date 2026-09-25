// =============================================================================
// scraper/tests/allowlistResolution.test.js
// =============================================================================
// WHAT: STEP 24 tests — operator resolution of allowlist freshness reviews:
//   inspect evidence, explicit UPDATE with validation + provenance, explicit
//   RETIRE with history preserved, rejection paths, idempotent re-resolution,
//   bounds, persistence continuity, and the no-publish/no-mutation boundary.
// WHY: Detection is automatic; remediation is human. Every test below proves
//   one half of that contract: the system validates and audits, never
//   decides, discovers, or publishes on its own.
// DB: isolated mongodb-memory-server only; MONGO_URI unset. All fetches are
//   injected stubs — never live sites. Cross-restart durability itself is
//   proven live against persistent MongoDB in STEP24_REPORT.md.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");

const { getExamCandidateModel } = require("../models/examCandidate");
const { getSurveillanceStateModel } = require("../models/surveillanceState");
const { getReviewStateModel } = require("../models/reviewState");
const { getAllowlistDeclarationModel, ALLOWLIST_DECLARATION_COLLECTION } = require("../models/allowlistDeclaration");
const {
  getEffectiveBulletinUrls,
  inspectFreshnessReview,
  resolveUpdate,
  resolveRetire,
} = require("../operations/allowlistResolution");
const { checkAllowlistFreshness } = require("../surveillance/allowlistFreshness");
const { parseArgs, main } = require("../cli/allowlist");
const { startIsolatedDb, closeIsolatedDb } = require("./helpers/isolatedDb");

const PDF_V1 = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("version-one-body")]);
const PDF_V2 = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("version-two-body!!")]);
const PDF_NEW = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("replacement-body!!")]);

function candidateDoc(id, overrides = {}) {
  return {
    candidateId: id,
    name: `Candidate ${id}`,
    sourceUrl: "http://127.0.0.1/",
    sourceDomain: "127.0.0.1",
    discoverySource: "step24-test-seed",
    discoveredAt: new Date("2026-01-01T00:00:00Z"),
    status: "DISCOVERED",
    ...overrides,
  };
}

function examAdapter(urls) {
  return { slug: "step24-exam", render: "static", bulletinUrls: urls, docRules: [] };
}

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

const PROVENANCE = { source: "official authority page", verification: "Information Bulletin anchor observed on authority site" };

describe("STEP 24 — operator resolution workflow", () => {
  let mongod;
  let mongoUri;
  let connection;
  let models;
  let savedMongoUri;

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("step24_resolution"));
    connection = await mongoose.createConnection(mongoUri).asPromise();
    models = {
      ExamCandidate: getExamCandidateModel(connection),
      SurveillanceState: getSurveillanceStateModel(connection),
      ReviewState: getReviewStateModel(connection),
      AllowlistDeclaration: getAllowlistDeclarationModel(connection),
    };
  });

  after(async () => {
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0, "resolution must not leak connections");
  });

  async function reset() {
    for (const model of Object.values(models)) await model.deleteMany({});
  }

  // Seeds a REVIEW_REQUIRED review for oldUrl by drifting stubbed content.
  async function driftedReview(id, oldUrl, adapter) {
    await models.ExamCandidate.create(candidateDoc(id));
    const base = {
      adapter,
      fetchDocument: stubTransport({ [oldUrl]: { contentType: "application/pdf", content: PDF_V1 } }, []),
    };
    await checkAllowlistFreshness(id, models, base);
    await checkAllowlistFreshness(id, models, {
      adapter,
      fetchDocument: stubTransport({ [oldUrl]: { contentType: "application/pdf", content: PDF_V2 } }, []),
    });
    return `surveillance:${id}`;
  }

  it("1. inspect retrieves review evidence without writing", async () => {
    await reset();
    const reviewKey = await driftedReview("dsc-inspect-1", "http://127.0.0.1/old.pdf", examAdapter(["http://127.0.0.1/old.pdf"]));
    const statesBefore = await models.SurveillanceState.countDocuments({});
    const viewed = await inspectFreshnessReview(models, reviewKey);
    assert.equal(viewed.items.length, 1);
    assert.match(viewed.items[0].item.field, /allowlist:/);
    assert.ok(viewed.items[0].observation);
    assert.ok(viewed.items[0].observation.contentHash);
    assert.ok(viewed.items[0].baseline);
    assert.equal(await models.SurveillanceState.countDocuments({}), statesBefore);
    await assert.rejects(inspectFreshnessReview(models, "surveillance:dsc-missing"), /unknown review/);
  });

  it("2. valid UPDATE verifies, persists, baselines, and audits", async () => {
    await reset();
    const reviewKey = await driftedReview("dsc-update-1", "http://127.0.0.1/old.pdf", examAdapter(["http://127.0.0.1/old.pdf"]));
    const adapter = examAdapter(["http://127.0.0.1/old.pdf"]);
    const out = await resolveUpdate({
      models,
      reviewKey,
      url: "http://127.0.0.1/old.pdf",
      newUrl: "http://127.0.0.1/new.pdf",
      operator: "op-1",
      reason: "authority rotated the CDN path; new anchor verified live",
      evidence: PROVENANCE,
      adapter,
      options: {
        fetchDocument: stubTransport({ "http://127.0.0.1/new.pdf": { contentType: "application/pdf", content: PDF_NEW } }, []),
      },
    });
    assert.equal(out.resolved, true);
    assert.deepEqual(out.declaration.urls, ["http://127.0.0.1/new.pdf"]);
    assert.deepEqual(out.declaration.retired, ["http://127.0.0.1/old.pdf"]);
    assert.equal(out.audit.decision, "UPDATE");
    assert.equal(out.audit.operator, "op-1");
    assert.equal(out.audit.newUrl, "http://127.0.0.1/new.pdf");
    assert.ok(out.audit.timestamp);
    assert.equal(out.declaration.resolutions.length, 1);
    assert.ok(out.baseline.contentHash);
    // Fresh baseline persisted for the new declaration.
    const state = await models.SurveillanceState.findOne({
      candidateId: "dsc-update-1",
      sourceUrl: "http://127.0.0.1/new.pdf",
    }).lean();
    assert.ok(state);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].outcome, "BASELINE");
    // Effective declarations now resolve through the override.
    const effective = await getEffectiveBulletinUrls({ adapter, AllowlistDeclaration: models.AllowlistDeclaration });
    assert.deepEqual(effective.urls, ["http://127.0.0.1/new.pdf"]);
    assert.deepEqual(effective.retired, ["http://127.0.0.1/old.pdf"]);
    assert.equal(effective.source, "override");
  });

  it("3. invalid UPDATE targets are rejected without mutation", async () => {
    await reset();
    const reviewKey = await driftedReview("dsc-badupdate-1", "http://127.0.0.1/old.pdf", examAdapter(["http://127.0.0.1/old.pdf"]));
    const adapter = examAdapter(["http://127.0.0.1/old.pdf"]);
    const base = {
      models, reviewKey, url: "http://127.0.0.1/old.pdf",
      operator: "op-1", reason: "rotated", evidence: PROVENANCE, adapter,
    };
    await assert.rejects(
      resolveUpdate({ ...base, newUrl: "http://127.0.0.1/dead.pdf", options: { fetchDocument: async () => { throw new Error("connection refused"); } } }),
      /failed validation/
    );
    await assert.rejects(
      resolveUpdate({ ...base, newUrl: "http://127.0.0.1/junk.pdf", options: { fetchDocument: stubTransport({ "http://127.0.0.1/junk.pdf": { contentType: "text/html", content: Buffer.from("nope") } }, []) } }),
      /failed validation/
    );
    await assert.rejects(resolveUpdate({ ...base, newUrl: "http://example.com/b.pdf" }), /never requested|must use https/);
    const doc = await models.AllowlistDeclaration.findOne({ adapterSlug: "step24-exam" }).lean();
    assert.equal(doc, null);
  });

  it("4. missing provenance and operators are rejected", async () => {
    await reset();
    const reviewKey = await driftedReview("dsc-prov-1", "http://127.0.0.1/old.pdf", examAdapter(["http://127.0.0.1/old.pdf"]));
    const adapter = examAdapter(["http://127.0.0.1/old.pdf"]);
    const good = {
      models, reviewKey, url: "http://127.0.0.1/old.pdf", newUrl: "http://127.0.0.1/new.pdf",
      operator: "op-1", reason: "rotated", evidence: PROVENANCE, adapter,
      options: { fetchDocument: stubTransport({ "http://127.0.0.1/new.pdf": { contentType: "application/pdf", content: PDF_NEW } }, []) },
    };
    await assert.rejects(resolveUpdate({ ...good, operator: "  " }), /requires an operator name/);
    await assert.rejects(resolveUpdate({ ...good, reason: "" }), /requires a reason/);
    await assert.rejects(resolveUpdate({ ...good, evidence: { source: "x" } }), /evidence.verification/);
    await assert.rejects(
      resolveRetire({ models, reviewKey, url: "http://127.0.0.1/old.pdf", adapter, operator: "", reason: "r", evidence: PROVENANCE }),
      /requires an operator name/
    );
    await assert.rejects(
      resolveRetire({ models, reviewKey: "surveillance:dsc-missing", url: "http://127.0.0.1/old.pdf", adapter, operator: "op", reason: "r", evidence: PROVENANCE }),
      /unknown review/
    );
  });

  it("5. RETIRE inactivates while preserving all history", async () => {
    await reset();
    const reviewKey = await driftedReview("dsc-retire-1", "http://127.0.0.1/old.pdf", examAdapter(["http://127.0.0.1/old.pdf"]));
    const adapter = examAdapter(["http://127.0.0.1/old.pdf"]);
    const statesBefore = await models.SurveillanceState.find({ candidateId: "dsc-retire-1" }).lean();
    assert.equal(statesBefore.length, 1);
    const out = await resolveRetire({
      models, reviewKey, url: "http://127.0.0.1/old.pdf", adapter,
      operator: "op-2", reason: "edition withdrawn; bulletin removed", evidence: PROVENANCE,
    });
    assert.equal(out.resolved, true);
    assert.deepEqual(out.declaration.urls, []);
    assert.deepEqual(out.declaration.retired, ["http://127.0.0.1/old.pdf"]);
    assert.equal(out.audit.decision, "RETIRE");
    assert.equal(out.audit.newUrl, null);
    // Surveillance history untouched: same docs, same entries.
    const statesAfter = await models.SurveillanceState.find({ candidateId: "dsc-retire-1" }).lean();
    assert.deepEqual(statesAfter, statesBefore);
    // Retired declarations no longer probe.
    const effective = await getEffectiveBulletinUrls({ adapter, AllowlistDeclaration: models.AllowlistDeclaration });
    assert.deepEqual(effective.urls, []);
  });

  it("6. redirect targets are never auto-adopted; explicit UPDATE works", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-redir-1"));
    const adapter = examAdapter(["http://127.0.0.1/old.pdf"]);
    const calls = [];
    await checkAllowlistFreshness("dsc-redir-1", models, {
      adapter,
      fetchDocument: stubTransport({ "http://127.0.0.1/old.pdf": { contentType: "application/pdf", content: PDF_V1 } }, calls),
    });
    const moved = await checkAllowlistFreshness("dsc-redir-1", models, {
      adapter,
      fetchDocument: stubTransport({
        "http://127.0.0.1/old.pdf": { contentType: "application/pdf", content: PDF_V1, finalUrl: "http://127.0.0.1/moved.pdf" },
      }, calls),
    });
    assert.equal(moved.driftStatus, "REVIEW_REQUIRED");
    // Declaration still holds ONLY the configured URL after drift detection.
    const effective = await getEffectiveBulletinUrls({ adapter, AllowlistDeclaration: models.AllowlistDeclaration });
    assert.deepEqual(effective.urls, ["http://127.0.0.1/old.pdf"]);
    // Operator explicitly adopts the observed target: allowed, audited.
    const out = await resolveUpdate({
      models,
      reviewKey: "surveillance:dsc-redir-1",
      url: "http://127.0.0.1/old.pdf",
      newUrl: "http://127.0.0.1/moved.pdf",
      operator: "op-3",
      reason: "authority redirect verified stable across two checks",
      evidence: PROVENANCE,
      adapter,
      options: {
        fetchDocument: stubTransport({ "http://127.0.0.1/moved.pdf": { contentType: "application/pdf", content: PDF_V1 } }, []),
      },
    });
    assert.equal(out.resolved, true);
    assert.deepEqual(out.declaration.urls, ["http://127.0.0.1/moved.pdf"]);
  });

  it("7. repeat resolution is an idempotent no-op; unknown items reject", async () => {
    await reset();
    const reviewKey = await driftedReview("dsc-idem-1", "http://127.0.0.1/old.pdf", examAdapter(["http://127.0.0.1/old.pdf"]));
    const adapter = examAdapter(["http://127.0.0.1/old.pdf"]);
    const first = await resolveRetire({
      models, reviewKey, url: "http://127.0.0.1/old.pdf", adapter,
      operator: "op-1", reason: "gone", evidence: PROVENANCE,
    });
    assert.equal(first.resolved, true);
    const second = await resolveRetire({
      models, reviewKey, url: "http://127.0.0.1/old.pdf", adapter,
      operator: "op-1", reason: "gone", evidence: PROVENANCE,
    });
    assert.equal(second.resolved, false);
    assert.equal(second.reason, "already resolved");
    const doc = await models.AllowlistDeclaration.findOne({ adapterSlug: "step24-exam" }).lean();
    assert.equal(doc.resolutions.length, 1);
    await assert.rejects(
      resolveRetire({ models, reviewKey, url: "http://127.0.0.1/other.pdf", adapter, operator: "op", reason: "r", evidence: PROVENANCE }),
      /no item for/
    );
  });

  it("8. bounds hold and freshness alone never mutates declarations", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-bound-1"));
    const urls = Array.from({ length: 7 }, (_, i) => `http://127.0.0.1/${i}.pdf`);
    const adapter = { slug: "step24-bound", render: "static", bulletinUrls: urls, docRules: [] };
    await models.ReviewState.create({
      draftId: "surveillance:dsc-bound-1",
      examSlug: null,
      stage: "REVIEW_REQUIRED",
      decidedAt: new Date(),
      items: [{ field: `allowlist:${urls[0]}`, reviewStatus: "REVIEW_REQUIRED" }],
      history: [],
    });
    const byUrl = Object.fromEntries(urls.map((url) => [url, { contentType: "application/pdf", content: PDF_V1 }]));
    const reviewKey = "surveillance:dsc-bound-1";
    // 7 declared - 1 replaced + 1 new = 7 > 5 -> refused, declaration untouched.
    await assert.rejects(
      resolveUpdate({
        models, reviewKey, url: urls[0], newUrl: "http://127.0.0.1/fresh.pdf",
        operator: "op", reason: "rotated", evidence: PROVENANCE, adapter,
        options: { fetchDocument: stubTransport({ "http://127.0.0.1/fresh.pdf": { contentType: "application/pdf", content: PDF_NEW } }, []) },
      }),
      /maximum bound/
    );
    assert.equal(await models.AllowlistDeclaration.countDocuments({}), 0);
  });

  it("9. freshness observation alone never mutates declarations", async () => {
    await reset();
    await models.ExamCandidate.create(candidateDoc("dsc-nomut-1"));
    const adapter = examAdapter(["http://127.0.0.1/old.pdf"]);
    const { checkAllowlistFreshness } = require("../surveillance/allowlistFreshness");
    await checkAllowlistFreshness("dsc-nomut-1", models, {
      adapter,
      fetchDocument: stubTransport({ "http://127.0.0.1/old.pdf": { contentType: "application/pdf", content: PDF_V1 } }, []),
    });
    await checkAllowlistFreshness("dsc-nomut-1", models, {
      adapter,
      fetchDocument: stubTransport({ "http://127.0.0.1/old.pdf": { contentType: "application/pdf", content: PDF_V2 } }, []),
    });
    assert.equal(await models.AllowlistDeclaration.countDocuments({}), 0);
  });

  it("10. CLI parses inspect/resolve commands", () => {
    const inspect = parseArgs(["inspect", "--review", "surveillance:dsc-1"]);
    assert.equal(inspect.command, "inspect");
    const update = parseArgs([
      "resolve", "--review", "surveillance:dsc-1", "--url", "http://127.0.0.1/o.pdf",
      "--update", "http://127.0.0.1/n.pdf", "--adapter", "jee-main",
      "--operator", "op", "--reason", "rotated",
      "--evidence-source", "authority page", "--evidence-verification", "anchor seen",
    ]);
    assert.equal(update.command, "resolve");
    assert.equal(update.update, "http://127.0.0.1/n.pdf");
    assert.equal(update.retire, false);
    const retire = parseArgs([
      "resolve", "--review", "surveillance:dsc-1", "--url", "http://127.0.0.1/o.pdf",
      "--retire", "--adapter", "jee-main",
      "--operator", "op", "--reason", "gone",
      "--evidence-source", "authority page", "--evidence-verification", "404 seen",
    ]);
    assert.equal(retire.retire, true);
    assert.throws(() => parseArgs([]), /a command is required/);
    assert.throws(() => parseArgs(["resolve", "--review", "r"]), /--url <oldUrl> is required/);
    assert.throws(
      () => parseArgs(["resolve", "--review", "r", "--url", "u", "--update", "n", "--retire", "--adapter", "a"]),
      /exactly one of --update/
    );
    assert.throws(() => parseArgs(["inspect", "--bogus"]), /unknown argument/);
    assert.equal(parseArgs(["--help"]).help, true);
  });

  it("11. resolution layer publishes nothing and names no exams", () => {
    for (const relative of ["operations/allowlistResolution.js", "models/allowlistDeclaration.js", "cli/allowlist.js"]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      assert.ok(!/require\(["'].*publish[^"']*["']\)/.test(code), `${relative}: no publish imports`);
      assert.ok(!/publishVerifiedDraft|confirmPublish|dryRunPublish/.test(code.replace(/\/\/.*$/gm, "")), `${relative}: no publish calls`);
      assert.ok(!/ExamModel\.create|\.insertMany|\.updateOne|\.updateMany|\.deleteOne|\.deleteMany/.test(code.replace(/\/\/.*$/gm, "")), `${relative}: no production-style writes`);
      const executable = code
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
        .replace(/\/\/.*$/gm, "");
      assert.ok(!/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable), `${relative}: no exam names`);
    }
    assert.equal(ALLOWLIST_DECLARATION_COLLECTION, "scraper_allowlist_declarations");
  });

  it("12. CLI help exits cleanly without infrastructure", async () => {
    assert.equal(await main(["--help"]), 0);
  });
});
