#!/usr/bin/env node
// =============================================================================
// scraper/pilot/pilotRun.js — STEP 15 live pilot runner (bounded, supervised)
// =============================================================================
// WHAT: Runs ONE real authority source through the deployed chain using the
//   existing modules only: surveillance (Step 12, live fetch) → single-exam
//   ingestion (Step 9, live fetchers) → audit skeleton with evidence attached
//   and verdicts null. The OPERATOR then inspects real sources, writes field
//   verdicts (reporting.js), and only on sign-off invokes promoteAndPublish()
//   explicitly — a second, deliberate command, never automatic.
// WHY: Measurement, not architecture. Every stage reuses production code
//   paths against live bytes; staging lives on an isolated database the
//   caller wires (tests never run this — it needs the network by definition).
// CONTRACT:
//   ensurePilotCandidate(ExamCandidate, spec) -> candidate doc (creates
//     DISCOVERED once by candidateId, reuses afterwards).
//   runPilotSource({ source, deps, options }) -> { surveillance, ingestion,
//     audit, durationMs } — audit fields carry evidence with verdict: null.
//   promoteAndPublish({ EditionDraft, Receipt, ExamModel, draftId, publishedBy })
//     -> promoteDraft + publishSingleDraft({ confirm: true }) + verification.
//     Call ONLY after operator sign-off; refuses non-VERIFIED outcomes.
// SOURCE SPEC: { slug, name, authorityDomain, sourceUrl, conductingBody,
//   adapter, year, cycle } — the adapter is an existing registry adapter.
// SAFETY: no batching (one source per call), no auto-publish, no re-verify
//   bypasses, no invented values. Results JSON (with live excerpts) belongs
//   under pilot/results/ (gitignored); the human report is PILOT_REPORT.md.
// =============================================================================

const { checkCandidateSource } = require("../surveillance/sourceSurveillance");
const { runEndToEndIngestion } = require("../pipeline/endToEndIngestion");
const { promoteDraft } = require("../pipeline/reviewPipeline");
const { publishSingleDraft } = require("../pipeline/publishIntegration");
const { candidateIdFor } = require("../discovery/examDiscovery");
const { newAuditRecord, recordField } = require("./reporting");

function auditValue(axis) {
  if (!axis || typeof axis !== "object") return null;
  if (axis.minLevel !== undefined) return axis.minLevel;
  if (axis.min !== undefined) return axis.min;
  if (axis.allowed !== undefined) return axis.allowed;
  if (axis.requiredAny !== undefined) return axis.requiredAny;
  return null;
}

async function ensurePilotCandidate(ExamCandidate, spec) {
  const candidateId = candidateIdFor(spec.name, spec.year === undefined ? null : spec.year);
  const existing = await ExamCandidate.findOne({ candidateId });
  if (existing) return existing;
  return ExamCandidate.create({
    candidateId,
    name: spec.name,
    description: null,
    conductingBody: spec.conductingBody || null,
    examUrl: null,
    edition: spec.year === undefined || spec.year === null ? null : String(spec.year),
    year: spec.year === undefined ? null : spec.year,
    sourceUrl: spec.sourceUrl,
    sourceDomain: spec.authorityDomain,
    discoverySource: "step15-pilot",
    discoverySources: ["step15-pilot"],
    discoveredAt: new Date(),
    lastSeenAt: new Date(),
    status: "DISCOVERED",
    evidence: [],
  });
}

async function runPilotSource({ source, deps, options = {} }) {
  const started = Date.now();
  if (!source || !source.adapter || !source.sourceUrl) {
    throw new Error("pilotRun: source with adapter and sourceUrl is required");
  }
  const candidate = await ensurePilotCandidate(deps.ExamCandidate, source);
  const runId = `pilot-${Date.now()}`;

  const surveillance = await checkCandidateSource(candidate.candidateId, {
    ExamCandidate: deps.ExamCandidate,
    SurveillanceState: deps.SurveillanceState,
    ReviewState: deps.ReviewState,
  }, { persist: true });

  const ingestion = await runEndToEndIngestion(
    candidate.candidateId,
    {
      ExamCandidate: deps.ExamCandidate,
      SourceProfile: deps.SourceProfile,
      RawDocument: deps.RawDocument,
      EditionDraft: deps.EditionDraft,
      ReviewState: deps.ReviewState,
      adapter: source.adapter,
    },
    { year: source.year, cycle: source.cycle, dryRun: true }
  );

  const audit = newAuditRecord({
    source: { slug: source.slug, authorityDomain: source.authorityDomain, sourceUrl: source.sourceUrl },
    exam: { name: source.name, year: source.year, cycle: source.cycle },
    runId,
  });
  const edition = ingestion.stages && ingestion.stages.extraction && ingestion.stages.extraction.normalizedEdition;
  if (edition) {
    const reg = edition.registration || {};
    recordField(audit, { field: "exam name", value: (ingestion.stages.extraction.normalizedExam || {}).name || null, status: null, evidence: null });
    recordField(audit, { field: "registration.startDate", value: reg.startDate || null, status: reg.startDate ? "KNOWN" : "UNKNOWN", evidence: (edition.sources || [])[0] || null });
    recordField(audit, { field: "registration.endDate", value: reg.endDate || null, status: reg.endDate ? "KNOWN" : "UNKNOWN", evidence: (edition.sources || [])[0] || null });
    for (const axis of Object.keys(edition.eligibility || {})) {
      const state = edition.eligibility[axis];
      recordField(audit, {
        field: `eligibility.${axis}`,
        value: auditValue(state),
        status: state.status,
        evidence: state.evidence || null,
      });
    }
  }

  return {
    source: source.slug,
    runId,
    durationMs: Date.now() - started,
    surveillance: {
      driftStatus: surveillance.driftStatus,
      driftTriggers: surveillance.driftTriggers,
      baselineEstablished: surveillance.baselineEstablished,
      error: surveillance.error || null,
    },
    ingestion: {
      stoppedAt: ingestion.stoppedAt,
      gates: ingestion.gates,
      documents: (ingestion.stages.discovery && ingestion.stages.discovery.documents) || [],
      fetch: ingestion.stages.fetch || null,
      processing: ingestion.stages.processing || null,
      extraction: ingestion.stages.extraction
        ? {
            year: ingestion.stages.extraction.year,
            cycle: ingestion.stages.extraction.cycle,
            stats: ingestion.stages.extraction.stats,
            normalizedExam: ingestion.stages.extraction.normalizedExam,
            normalizedEdition: ingestion.stages.extraction.normalizedEdition,
          }
        : null,
      validation: ingestion.stages.validation || null,
      confidence: ingestion.stages.confidence || null,
      review: ingestion.review || null,
      draft: ingestion.draft || null,
    },
    audit,
  };
}

async function promoteAndPublish({ EditionDraft, Receipt, ExamModel, draftId, publishedBy }) {
  if (typeof draftId !== "string" || !draftId) {
    throw new Error("pilotRun: exactly one draftId is required");
  }
  const promoted = await promoteDraft(EditionDraft, draftId);
  if (promoted.status !== "VERIFIED") {
    throw new Error(`pilotRun: promotion did not verify (status: ${promoted.status})`);
  }
  return publishSingleDraft({ EditionDraft, Receipt, ExamModel }, String(promoted._id), {
    confirm: true,
    publishedBy: publishedBy || "step15-pilot-operator",
  });
}

module.exports = {
  ensurePilotCandidate,
  runPilotSource,
  promoteAndPublish,
};
