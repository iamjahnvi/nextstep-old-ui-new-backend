const mongoose = require("mongoose");

const { getExamCandidateModel } = require("../models/examCandidate");
const { getSurveillanceStateModel } = require("../models/surveillanceState");
const { getReviewStateModel } = require("../models/reviewState");
const { getAllowlistDeclarationModel } = require("../models/allowlistDeclaration");
const { checkAllowlistFreshness } = require("../surveillance/allowlistFreshness");
const { getFreshnessDashboard } = require("../surveillance/freshnessDashboard");

const phase = process.argv[2];
const mongoUri = process.env.STEP30_MONGO_URI;
const candidateId = process.env.STEP30_CANDIDATE_ID;
const adapterSlug = process.env.STEP30_ADAPTER_SLUG;
const bulletinUrl = "https://step30.invalid/bulletin.pdf";
const PDF_V1 = Buffer.from("%PDF-1.7\nstep30-baseline");
const PDF_V2 = Buffer.from("%PDF-1.7\nstep30-changed");

if (!mongoUri || !candidateId || !adapterSlug) {
  throw new Error("STEP30_MONGO_URI, STEP30_CANDIDATE_ID, and STEP30_ADAPTER_SLUG are required");
}

function adapter() {
  return { slug: adapterSlug, name: "Step 30 Persistence Candidate", bulletinUrls: [bulletinUrl] };
}

function fetchDocument(content) {
  return async () => ({
    url: bulletinUrl,
    type: "PDF",
    status: 200,
    contentType: "application/pdf",
    content,
  });
}

function buildModels(connection) {
  return {
    ExamCandidate: getExamCandidateModel(connection),
    SurveillanceState: getSurveillanceStateModel(connection),
    ReviewState: getReviewStateModel(connection),
    AllowlistDeclaration: getAllowlistDeclarationModel(connection),
  };
}

async function readDashboard(models, connection, monitorWrites = false) {
  const writes = [];
  if (monitorWrites) {
    connection.on("commandStarted", (event) => {
      if (["insert", "update", "delete", "bulkWrite", "findAndModify", "create", "createIndexes"].includes(event.commandName)) {
        writes.push(event.commandName);
      }
    });
  }
  const dashboard = await getFreshnessDashboard(
    { candidateId, limit: 1 },
    models,
    { resolveAdapter: async () => adapter() }
  );
  return { dashboard, writes };
}

async function main() {
  if (phase !== "seed" && phase !== "verify-baseline" && phase !== "change" && phase !== "verify-change") {
    throw new Error(`unknown STEP 30 phase: ${phase}`);
  }
  const connection = await mongoose.createConnection(mongoUri).asPromise();
  const models = buildModels(connection);
  try {
    if (phase === "seed") {
      await models.ExamCandidate.deleteMany({ candidateId });
      await models.SurveillanceState.deleteMany({ candidateId });
      await models.ReviewState.deleteMany({ draftId: `surveillance:${candidateId}` });
      await models.AllowlistDeclaration.deleteMany({ adapterSlug });
      await models.ExamCandidate.create({
        candidateId,
        name: "Step 30 Persistence Candidate",
        sourceUrl: bulletinUrl,
        sourceDomain: "step30.invalid",
        discoverySource: "step30-persistence-test",
        discoveredAt: new Date("2026-01-01T00:00:00Z"),
        status: "DISCOVERED",
      });
      await models.AllowlistDeclaration.create({
        adapterSlug,
        urls: [bulletinUrl],
        retired: [],
        resolutions: [],
      });
      const baseline = await checkAllowlistFreshness(candidateId, models, {
        adapter: adapter(),
        fetchDocument: fetchDocument(PDF_V1),
        now: () => new Date("2026-02-01T00:00:00Z"),
      });
      const stable = await checkAllowlistFreshness(candidateId, models, {
        adapter: adapter(),
        fetchDocument: fetchDocument(PDF_V1),
        now: () => new Date("2026-02-02T00:00:00Z"),
      });
      const { dashboard } = await readDashboard(models, connection);
      console.log(JSON.stringify({ phase, baseline, stable, dashboard }));
    } else if (phase === "verify-baseline") {
      const state = await models.SurveillanceState.findOne({ candidateId, sourceUrl: bulletinUrl }).lean();
      const review = await models.ReviewState.findOne({ draftId: `surveillance:${candidateId}` }).lean();
      const declaration = await models.AllowlistDeclaration.findOne({ adapterSlug }).lean();
      const { dashboard, writes } = await readDashboard(models, connection, true);
      console.log(JSON.stringify({ phase, state, review, declaration, dashboard, writes }));
    } else if (phase === "change") {
      const changed = await checkAllowlistFreshness(candidateId, models, {
        adapter: adapter(),
        fetchDocument: fetchDocument(PDF_V2),
        now: () => new Date("2026-02-03T00:00:00Z"),
      });
      console.log(JSON.stringify({ phase, changed }));
    } else {
      const state = await models.SurveillanceState.findOne({ candidateId, sourceUrl: bulletinUrl }).lean();
      const review = await models.ReviewState.findOne({ draftId: `surveillance:${candidateId}` }).lean();
      const declaration = await models.AllowlistDeclaration.findOne({ adapterSlug }).lean();
      const { dashboard, writes } = await readDashboard(models, connection, true);
      console.log(JSON.stringify({ phase, state, review, declaration, dashboard, writes }));
    }
  } finally {
    await connection.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
