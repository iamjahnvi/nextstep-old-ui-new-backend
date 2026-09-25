// =============================================================================
// scraper/pipeline/endToEndIngestion.js — STEP 9 dry-run ingestion (one exam)
// =============================================================================
// WHAT: Single-candidate orchestration across the generic Steps 2–8 modules:
//   load DISCOVERED candidate → verify source → profile source → discover
//   documents → fetch → document-process → extract+normalize → validate →
//   confidence/review → stage a DRAFT. Then STOP. Dry-run only: staging
//   writes, zero production writes, zero publishing, one candidate.
// WHY: Prove the generic architecture composes end to end before any batch or
//   production thinking. Every stage returns structured output; gates are
//   explicit; failures name their stage; nothing is guessed past a gate.
// GATES (explicit in the result; a closed gate stops the run as REVIEW_REQUIRED):
//   SOURCE_VERIFICATION : candidate must reach SOURCE_VERIFIED.
//   DOCUMENT_REVIEW     : at least one relevant document must be discovered.
//   EXTRACTION_REVIEW   : extraction must yield a valid draft with evidence.
//   DRAFT_REVIEW        : terminal success state — staged DRAFT + review state,
//                         awaiting a human (never auto-promoted/published).
// FAILURE STAGES (exact, never swallowed): DISCOVERY_FAILED | FETCH_FAILED |
//   PROCESSING_FAILED | EXTRACTION_FAILED | NORMALIZATION_FAILED |
//   VALIDATION_FAILED | REVIEW_REQUIRED (gate stop).
// CONTRACT:
//   runEndToEndIngestion(candidateId, deps, options)
//     deps: { ExamCandidate, SourceProfile, RawDocument, EditionDraft,
//             ReviewState, adapter } — staging models only (collection
//             allow-list enforced) + one registry adapter object.
//     options: { fetchPage?, fetchDocument?, serviceUrl?, year?, cycle?,
//                maxDocuments?, dryRun?, now? } — fetchers injectable (tests
//                stub them; defaults are render-aware via
//                fetchers/transportSelector: static keeps the existing
//                httpFetcher/documentFetcher path verbatim, render "js" uses
//                the pooled-browser transport with download capture).
//                dryRun must be true (anything else throws); now defaults to
//                () => new Date() (tests inject a fixed clock).
//     -> result { dryRun, candidateId, adapter, stages, gates, stoppedAt,
//        draft, review, confirmation } — inspectable, deterministic modulo
//        timestamps/ids (see "deterministic projection" in tests).
// DRY-RUN GUARANTEE: the orchestrator only ever touches the five staging
//   collections above. Production models are refused by allow-list, publish/
//   code is never imported, and no PUBLISHED/VERIFIED state is produced.
// GENERICITY: no exam names, no field-specific extraction — all domain logic
//   lives in the reused modules.
// =============================================================================

const { SourceAdapterConfigSchema } = require("../registry/schema");
const { applyVerification } = require("../discovery/sourceVerification");
const { profileCandidate } = require("../discovery/sourceProfiler");
const { discoverFromSource } = require("../discovery/documentDiscovery");
const { processDocument } = require("./documentProcessing");
const { runExtractionPipeline } = require("./extractionPipeline");
const { normalizeRegistration } = require("../normalizers/dates");
const { saveRawDocument } = require("../persistence/rawDocumentStore");
const { saveDraft } = require("./reviewPipeline");
const { decideFieldReview, buildReviewItem, decideDraftReview, recordReviewState } = require("../review/reviewDecision");

const STAGING_COLLECTIONS = [
  "scraper_exam_candidates",
  "scraper_source_profiles",
  "scraper_rawdocuments",
  "scraper_editiondrafts",
  "scraper_review_states",
];

const FAILURE_STAGES = [
  "DISCOVERY_FAILED",
  "FETCH_FAILED",
  "PROCESSING_FAILED",
  "EXTRACTION_FAILED",
  "NORMALIZATION_FAILED",
  "VALIDATION_FAILED",
  "REVIEW_REQUIRED",
];

function assertStagingModels(deps) {
  for (const key of ["ExamCandidate", "SourceProfile", "RawDocument", "EditionDraft", "ReviewState"]) {
    const model = deps && deps[key];
    if (!model || !model.collection) {
      throw new Error(`endToEndIngestion: staging model ${key} is required`);
    }
    if (!STAGING_COLLECTIONS.includes(model.collection.name)) {
      throw new Error(
        `endToEndIngestion: refusing model on collection "${model.collection.name}" (staging only, never production)`
      );
    }
  }
  if (!deps.adapter || typeof deps.adapter.slug !== "string") {
    throw new Error("endToEndIngestion: a registry adapter is required");
  }
}

function axisValue(axis) {
  if (!axis || typeof axis !== "object") return null;
  if (axis.minLevel !== undefined) return axis.minLevel;
  if (axis.min !== undefined) return axis.min;
  if (axis.allowed !== undefined) return axis.allowed;
  if (axis.requiredAny !== undefined) return axis.requiredAny;
  return null;
}

async function runEndToEndIngestion(candidateId, deps, options = {}) {
  if (typeof candidateId !== "string" || !candidateId) {
    throw new Error("endToEndIngestion: candidateId is required");
  }
  if (options.dryRun === false || process.env.DRY_RUN === "false") {
    throw new Error("endToEndIngestion: only dry-run ingestion is supported (no publishing path exists)");
  }
  assertStagingModels(deps);
  const adapter = SourceAdapterConfigSchema.parse(deps.adapter);
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const maxDocuments =
    typeof options.maxDocuments === "number" && options.maxDocuments >= 1 ? Math.floor(options.maxDocuments) : 10;

  const stages = {};
  const gates = {
    SOURCE_VERIFICATION: "pending",
    DOCUMENT_REVIEW: "pending",
    EXTRACTION_REVIEW: "pending",
    DRAFT_REVIEW: "pending",
  };
  const confirmation = { published: false, productionWrites: 0, candidatesProcessed: 1 };

  // -- LOAD ---------------------------------------------------------------
  const candidate = await deps.ExamCandidate.findOne({ candidateId });
  if (!candidate) {
    stages.load = { status: "failed", error: `candidate not found: ${candidateId}` };
    return {
      dryRun: true,
      candidateId,
      adapter: adapter.slug,
      stages,
      gates,
      stoppedAt: { stage: "DISCOVERY_FAILED", reason: `candidate not found: ${candidateId}` },
      confirmation,
    };
  }
  if (candidate.status !== "DISCOVERED") {
    stages.load = { status: "stopped", candidateStatus: candidate.status };
    const result = { dryRun: true, candidateId, adapter: adapter.slug, stages, gates, confirmation };
    result.stoppedAt = { stage: "REVIEW_REQUIRED", reason: `candidate status is ${candidate.status}, only DISCOVERED candidates ingest` };
    return result;
  }
  stages.load = {
    status: "ok",
    candidate: { candidateId: candidate.candidateId, name: candidate.name, sourceUrl: candidate.sourceUrl, status: candidate.status },
  };

  // -- VERIFY (gate: SOURCE_VERIFICATION) ----------------------------------
  let verification;
  try {
    verification = await applyVerification(deps.ExamCandidate, deps.SourceProfile, candidateId, {
      adapters: [adapter],
      decidedAt: now(),
    });
  } catch (error) {
    stages.verification = { status: "failed", error: error.message };
    const result = { dryRun: true, candidateId, adapter: adapter.slug, stages, gates, confirmation };
    result.stoppedAt = { stage: "DISCOVERY_FAILED", reason: `verification error: ${error.message}` };
    return result;
  }
  stages.verification = {
    status: verification.result.status === "SOURCE_VERIFIED" ? "ok" : "stopped",
    verificationStatus: verification.result.status,
    reason: verification.result.reason,
    signals: verification.result.signals,
  };
  if (verification.result.status !== "SOURCE_VERIFIED") {
    gates.SOURCE_VERIFICATION = "stopped";
    const result = { dryRun: true, candidateId, adapter: adapter.slug, stages, gates, confirmation };
    result.stoppedAt = { stage: "REVIEW_REQUIRED", reason: `SOURCE_VERIFICATION gate: ${verification.result.reason}` };
    return result;
  }
  gates.SOURCE_VERIFICATION = "passed";

  // -- PROFILE -------------------------------------------------------------
  const profiled = profileCandidate(candidate.toObject(), { adapters: [adapter] });
  await deps.SourceProfile.findOneAndUpdate(
    { candidateId },
    {
      $set: {
        profile: { ...profiled, profiledAt: now(), profiler: "sourceProfiler.v1" },
        sourceUrl: candidate.sourceUrl,
        sourceDomain: candidate.sourceDomain,
      },
    }
  );
  stages.profile = {
    status: "ok",
    type: profiled.type,
    transport: profiled.transport,
    documentTypes: profiled.documentTypes,
    requiresJavaScript: profiled.requiresJavaScript,
    signals: profiled.signals,
  };

  // -- DISCOVER (gate: DOCUMENT_REVIEW) ------------------------------------
  let discovery;
  try {
    discovery = await discoverFromSource(
      { sourceUrl: candidate.sourceUrl, sourceDomain: candidate.sourceDomain, verificationStatus: "SOURCE_VERIFIED" },
      {
        fetchPage: options.fetchPage,
        adapter,
        maxDepth: 1,
        maxPages: 5,
        maxDocuments,
        adapterDocRules: adapter.docRules,
        discoveredAt: now(),
      }
    );
  } catch (error) {
    stages.discovery = { status: "failed", error: error.message };
    const result = { dryRun: true, candidateId, adapter: adapter.slug, stages, gates, confirmation };
    result.stoppedAt = { stage: "DISCOVERY_FAILED", reason: error.message };
    return result;
  }
  stages.discovery = {
    status: discovery.documents.length > 0 ? "ok" : "stopped",
    documents: discovery.documents.map((doc) => ({
      url: doc.url,
      label: doc.label,
      title: doc.title,
      documentType: doc.documentType,
      relevanceScore: doc.relevanceScore,
      depth: doc.depth,
      matchedSignals: doc.matchedSignals,
    })),
    stats: discovery.stats,
  };
  if (discovery.documents.length === 0) {
    gates.DOCUMENT_REVIEW = "stopped";
    const result = { dryRun: true, candidateId, adapter: adapter.slug, stages, gates, confirmation };
    result.stoppedAt = { stage: "REVIEW_REQUIRED", reason: "DOCUMENT_REVIEW gate: no relevant documents discovered" };
    return result;
  }
  gates.DOCUMENT_REVIEW = "passed";

  // -- BULLETIN FALLBACK (js adapters only; bounded, evidence-driven) ------
  // Runs only when normal discovery surfaced no bulletin/adapter-matched
  // document. Static adapters skip it entirely (needsBulletinFallback is
  // false), so their flow is byte-identical. Accepted raws join the fetch
  // set below; rejections stay recorded here, never swallowed.
  const { needsBulletinFallback, probeBulletinFallback } = require("../discovery/bulletinFallback");
  let fallback = { status: "skipped", probed: [], accepted: [] };
  if (needsBulletinFallback(discovery.documents, adapter)) {
    try {
      const probe = await probeBulletinFallback(
        {
          source: {
            sourceUrl: candidate.sourceUrl,
            sourceDomain: candidate.sourceDomain,
            verificationStatus: "SOURCE_VERIFIED",
          },
          adapter,
        },
        {
          fetchPage: options.fetchPage,
          fetchDocument: options.fetchDocument,
          adapterDocRules: adapter.docRules,
          knownUrls: discovery.documents.map((doc) => doc.url),
          maxCandidates: options.fallbackMaxCandidates,
          discoveredAt: now(),
        }
      );
      fallback = {
        status: probe.accepted.length > 0 ? "ok" : probe.error ? "failed" : "empty",
        error: probe.error || null,
        probed: probe.probed,
        accepted: probe.accepted,
      };
    } catch (error) {
      fallback = { status: "failed", error: error.message, probed: [], accepted: [] };
    }
  }
  stages.fallback = fallback;

  // -- BULLETIN ALLOWLIST (STEP 22; last fallback in the precedence chain) --
  // Runs only while no bulletin/adapter-matched document exists yet — i.e.
  // neither normal discovery nor the Step 21 probe produced one — AND the
  // adapter declares exact bulletinUrls. Each declared URL is probed exactly
  // as written (never generated, mutated, or expanded) through the
  // render-aware transport and validated by the shared document gate.
  // Adapters without declarations skip this entirely (no behavior change).
  const { needsAllowlistProbe, probeAllowlistUrls } = require("../discovery/bulletinFallback");
  let allowlist = { status: "skipped", probed: [], accepted: [] };
  if (needsAllowlistProbe({ documents: discovery.documents, fallbackAccepted: fallback.accepted, adapter })) {
    try {
      const probe = await probeAllowlistUrls(
        {
          source: {
            sourceUrl: candidate.sourceUrl,
            sourceDomain: candidate.sourceDomain,
            verificationStatus: "SOURCE_VERIFIED",
          },
          adapter,
        },
        {
          fetchDocument: options.fetchDocument,
          adapterDocRules: adapter.docRules,
          maxCandidates: options.allowlistMaxCandidates,
        }
      );
      allowlist = {
        status: probe.accepted.length > 0 ? "ok" : "empty",
        probed: probe.probed,
        accepted: probe.accepted,
      };
    } catch (error) {
      allowlist = { status: "failed", error: error.message, probed: [], accepted: [] };
    }
  }
  stages.allowlist = allowlist;

  // -- FETCH (document failures preserved, never swallowed) -----------------
  // Render-aware default: static delegates to documentFetcher exactly as
  // before; js adapters fetch HTML through the pooled browser and PDFs
  // through the browser download capture (transportSelector).
  const fetchVia =
    typeof options.fetchDocument === "function"
      ? options.fetchDocument
      : async (meta) => require("../fetchers/transportSelector").fetchDocumentForAdapter(meta, adapter);
  const fetched = [];
  const fetchFailures = [];
  for (const doc of discovery.documents.slice(0, maxDocuments)) {
    try {
      const raw = await fetchVia({
        label: doc.title || doc.label,
        url: doc.url,
        sourceUrl: doc.sourceUrl,
        type: doc.documentType,
      });
      fetched.push(raw);
    } catch (error) {
      fetchFailures.push({ url: doc.url, label: doc.label, error: error.message });
    }
  }
  // Fallback- and allowlist-accepted raws are already fetched RawDocuments
  // (probed through the render-aware transport); they join the set for
  // staging/extraction.
  for (const raw of fallback.accepted) {
    if (!fetched.some((existing) => existing.url === raw.url)) fetched.push(raw);
  }
  for (const raw of allowlist.accepted) {
    if (!fetched.some((existing) => existing.url === raw.url)) fetched.push(raw);
  }
  const storedRefs = [];
  for (const raw of fetched) {
    const { document } = await saveRawDocument(deps.RawDocument, raw);
    storedRefs.push({ documentId: document._id, url: raw.url, checksum: document.checksum, label: raw.label });
  }
  stages.fetch = {
    status: fetched.length > 0 ? "ok" : "failed",
    fetched: fetched.map((raw) => ({ url: raw.url, label: raw.label, type: raw.type, status: raw.status })),
    failed: fetchFailures,
    stored: storedRefs.length,
  };
  if (fetched.length === 0) {
    const result = { dryRun: true, candidateId, adapter: adapter.slug, stages, gates, confirmation };
    result.stoppedAt = { stage: "FETCH_FAILED", reason: "all document fetches failed" };
    return result;
  }

  // -- PROCESS (node path or Python specialist; failures isolated) ----------
  const processable = [];
  const processingErrors = [];
  for (const raw of fetched) {
    const outcome = await processDocument(raw, {
      profile: { type: profiled.type },
      serviceUrl: options.serviceUrl,
    });
    if (outcome.ok && (outcome.handled !== false || outcome.path === "node")) {
      if (outcome.ok && outcome.handled === false) {
        processable.push({ raw, via: "node" });
      } else if (outcome.ok) {
        processable.push({ raw, via: "python", representation: outcome.representation });
      }
    } else {
      processingErrors.push({ url: raw.url, error: outcome.error || outcome });
    }
  }
  stages.processing = {
    status: processable.length > 0 ? "ok" : "failed",
    results: fetched.map((raw) => {
      const kept = processable.find((p) => p.raw.url === raw.url);
      const err = processingErrors.find((e) => e.url === raw.url);
      return { url: raw.url, via: kept ? kept.via : null, error: err ? err.error : null };
    }),
  };
  if (processable.length === 0) {
    const result = { dryRun: true, candidateId, adapter: adapter.slug, stages, gates, confirmation };
    result.stoppedAt = { stage: "PROCESSING_FAILED", reason: "no fetched document could be processed" };
    return result;
  }

  // -- EXTRACT + NORMALIZE + VALIDATE --------------------------------------
  let extraction;
  try {
    extraction = await runExtractionPipeline(adapter, {
      rawDocuments: processable.map((p) => p.raw),
      year: options.year,
      cycle: options.cycle,
    });
  } catch (error) {
    const message = error.message || String(error);
    const failedStage = /invalid draft/i.test(message) ? "VALIDATION_FAILED" : "EXTRACTION_FAILED";
    stages.extraction = { status: "failed", error: message };
    const result = { dryRun: true, candidateId, adapter: adapter.slug, stages, gates, confirmation };
    result.stoppedAt = { stage: failedStage, reason: message.slice(0, 500) };
    return result;
  }
  // Normalization invariant: the pipeline nulls contradictory windows, so a
  // present-but-contradictory pair reaching here means a normalizer broke.
  const { startDate, endDate } = extraction.edition.registration || {};
  const normalized = normalizeRegistration(startDate || null, endDate || null);
  if (startDate && endDate && normalized.startDate === null && normalized.endDate === null) {
    stages.extraction = { status: "failed", error: "normalizer contradiction in registration window" };
    const result = { dryRun: true, candidateId, adapter: adapter.slug, stages, gates, confirmation };
    result.stoppedAt = { stage: "NORMALIZATION_FAILED", reason: "registration window is contradictory" };
    return result;
  }
  stages.extraction = {
    status: "ok",
    year: extraction.year,
    cycle: extraction.cycle,
    stats: extraction.stats,
    normalizedExam: extraction.exam,
    normalizedEdition: {
      examSlug: extraction.edition.examSlug,
      year: extraction.edition.year,
      cycle: extraction.edition.cycle,
      registration: {
        startDate: extraction.edition.registration.startDate,
        endDate: extraction.edition.registration.endDate,
      },
      eligibility: extraction.edition.eligibility,
    },
  };
  stages.validation = { status: "ok", examOk: true, editionOk: true };

  // -- EVIDENCE + CONFIDENCE + REVIEW --------------------------------------
  const editionSources = Array.isArray(extraction.edition.sources) ? extraction.edition.sources : [];
  const fieldInputs = [];
  for (const axis of Object.keys(extraction.edition.eligibility || {})) {
    const axisState = extraction.edition.eligibility[axis];
    fieldInputs.push({
      field: `eligibility.${axis}`,
      value: axisDisplayValue(axisState),
      status: axisState.status,
      evidence: axisState.evidence || null,
      sourcesCount: 1,
    });
  }
  for (const key of ["startDate", "endDate"]) {
    const value = extraction.edition.registration ? extraction.edition.registration[key] : null;
    fieldInputs.push({
      field: `registration.${key}`,
      value: value || null,
      status: value ? "KNOWN" : "UNKNOWN",
      evidence: editionSources[0] || null,
      sourcesCount: editionSources.length,
    });
  }
  const items = fieldInputs.map((input) =>
    buildReviewItem({ ...input, reconciliation: null, llmProposal: null })
  );
  const draftDecision = decideDraftReview(items);
  stages.confidence = {
    status: "ok",
    fields: items.map((item) => ({ field: item.field, confidence: item.confidence, reviewStatus: item.reviewStatus })),
  };
  stages.review = { status: "ok", stage: draftDecision.stage, summary: draftDecision.summary };

  const hasEvidence = editionSources.length > 0 || items.some((item) => item.excerpts.length > 0);
  if (!hasEvidence) {
    gates.EXTRACTION_REVIEW = "stopped";
    const result = {
      dryRun: true, candidateId, adapter: adapter.slug, stages, gates, confirmation,
      review: { items },
    };
    result.stoppedAt = { stage: "REVIEW_REQUIRED", reason: "EXTRACTION_REVIEW gate: valid draft but no evidence attached" };
    return result;
  }
  gates.EXTRACTION_REVIEW = "passed";

  // -- DRAFT (gate: DRAFT_REVIEW — terminal success: staged, awaiting human) --
  const draft = await saveDraft(deps.EditionDraft, {
    exam: extraction.exam,
    edition: extraction.edition,
    rawDocuments: storedRefs.filter((ref) => processable.some((p) => p.raw.url === ref.url)),
  });
  const reviewState = await recordReviewState(
    deps.ReviewState,
    String(draft._id),
    { stage: draftDecision.stage === "READY_FOR_REVIEW" ? "READY_FOR_REVIEW" : "REVIEW_REQUIRED", items },
    { examSlug: extraction.edition.examSlug }
  );
  gates.DRAFT_REVIEW = "reached";
  stages.draft = { status: "ok", draftId: String(draft._id), draftStatus: draft.status };

  return {
    dryRun: true,
    candidateId,
    adapter: adapter.slug,
    stages,
    gates,
    draft: { draftId: String(draft._id), status: draft.status },
    review: { stage: reviewState.stage, items, summary: draftDecision.summary },
    stoppedAt: { stage: "DRAFT_REVIEW", reason: "dry-run complete: staged DRAFT with review state, awaiting human review (never promoted, never published)" },
    confirmation,
  };
}

function axisDisplayValue(axisState) {
  if (!axisState || typeof axisState !== "object") return null;
  if (axisState.minLevel !== undefined) return axisState.minLevel;
  if (axisState.min !== undefined) return axisState.min;
  if (axisState.allowed !== undefined) return axisState.allowed;
  if (axisState.requiredAny !== undefined) return axisState.requiredAny;
  return null;
}

module.exports = {
  STAGING_COLLECTIONS,
  FAILURE_STAGES,
  runEndToEndIngestion,
};
