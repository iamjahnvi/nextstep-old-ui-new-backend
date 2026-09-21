// =============================================================================
// scraper/pipeline/extractionPipeline.js
// =============================================================================
// WHAT: Structured extraction pipeline — the ONLY place the Phase 5 pieces are
//   orchestrated together:
//     load staged RawDocuments → prepare text (HTML → htmlParser,
//       PDF → pdfParser + cleanPDFText) → extract registration dates +
//       eligibility → normalize → validate → ExamEdition DRAFT (in-memory).
// WHY: The pipeline owns sequencing and nothing else. Parsing, extraction,
//   normalization and validation each live in their own module and are reused
//   here — nothing is duplicated, no fetching/discovery logic is re-made.
// SCOPE: read-only over staging + in-memory draft output. NEVER writes the
//   production/demo Exam collections, NEVER invents facts: missing information
//   stays UNKNOWN with null dates, status is always DRAFT, careerType/examType
//   stay null, and there is no month field (rejected by .strict() schemas).
// CONTRACT:
//   runExtractionPipeline(adapterConfig, options = {})
//     adapterConfig : registry adapter object (validated against
//                     registry/schema.js; fail fast before any I/O).
//     options.mongoUri      : isolated staging URI (required unless
//                             options.rawDocuments is given).
//     options.sourceUrl     : only load docs staged from this page URL.
//                             Defaults to adapter.startUrls.
//     options.rawDocuments  : pre-loaded RawDocument-like objects
//                             { label, url, sourceUrl, type, fetchedAt, status,
//                               contentType, content } — skips the DB read
//                             (unit tests, offline use).
//     options.textProvider  : async (rawDoc) -> string override for prepared
//                             text (tests stub PDF parsing without pdf-parse).
//     options.year / cycle  : explicit edition identity; else derived from
//                             the extracted start/end date, else the newest
//                             fetchedAt year, else the current year.
//   Returns a print-safe result:
//     { adapter, year, cycle, documents, exam, edition,
//       validation: { examOk, editionOk },
//       stats: { textChars, sources } }.
//   Throws on validation failure — an invalid draft is never returned quietly.
// =============================================================================

const mongoose = require("mongoose");
const { SourceAdapterConfigSchema } = require("../registry/schema");
const parseHTML = require("../parsers/htmlParser");
const { parsePDFBuffer } = require("../parsers/pdfParser");
const cleanPDFText = require("../normalizers/pdfText");
const { normalizeReadContent } = require("../persistence/rawDocumentStore");
const { extractRegistrationDates } = require("../extractors/registrationDates");
const { extractEligibility } = require("../extractors/eligibility");
const {
  validateExam,
  validateExamEdition,
  buildUnknownEligibility,
} = require("../validators/examValidator");
const { getRawDocumentModel } = require("../models/rawDocument");

const EXCERPT_CHARS = 500;

function excerptOf(text) {
  const collapsed = String(text || "").replace(/\s+/g, " ").trim();
  return collapsed ? collapsed.slice(0, EXCERPT_CHARS) : null;
}

// Prepare plain text from one RawDocument without refetching anything.
// HTML/OTHER: title + headings + paragraphs + table text via the shared
// htmlParser. Table text matters because official schedule pages commonly
// publish dates in <table> markup with no <p> wrapper.
// PDF: bytes via the shared pdfParser, cleaned with the ADAPTER's
// cleanPatterns (registry-owned boilerplate rules; no hardcoded strings).
// Text can also be injected via options.textProvider (tests only).
async function prepareText(rawDoc, options = {}, adapter = {}) {
  if (!rawDoc) throw new Error("extractionPipeline: raw document is required");
  if (options.textProvider) return String((await options.textProvider(rawDoc)) || "");

  if (rawDoc.type === "PDF") {
    const buffer = normalizeReadContent(rawDoc.type, rawDoc.content);
    if (!Buffer.isBuffer(buffer)) {
      throw new Error("extractionPipeline: PDF content is not binary-readable");
    }
    return cleanPDFText(await parsePDFBuffer(buffer), adapter.cleanPatterns);
  }

  const html = normalizeReadContent(rawDoc.type, rawDoc.content);
  const parsed = parseHTML(String(html));
  return [parsed.title, ...parsed.headings, ...parsed.paragraphs, ...(parsed.tables || [])]
    .filter(Boolean)
    .join("\n");
}

function docProvenance(rawDoc, extractor) {
  return {
    sourceUrl: rawDoc.sourceUrl,
    documentUrl: rawDoc.url,
    docType: rawDoc.type,
    retrievedAt: rawDoc.fetchedAt,
    section: rawDoc.label || null,
    extractor,
  };
}

async function loadStagedDocuments(adapter, options) {
  if (Array.isArray(options.rawDocuments)) return options.rawDocuments;
  const mongoUri = options.mongoUri || process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error(
      "extractionPipeline: no MongoDB URI (pass options.mongoUri or options.rawDocuments)"
    );
  }
  const connection = await mongoose.createConnection(mongoUri).asPromise();
  try {
    const RawDocument = getRawDocumentModel(connection);
    const wanted = Array.isArray(options.sourceUrl)
      ? options.sourceUrl
      : options.sourceUrl
        ? [options.sourceUrl]
        : adapter.startUrls;
    const docs = await RawDocument.find({ sourceUrl: { $in: wanted } })
      .sort({ fetchedAt: -1 })
      .lean();
    if (docs.length > 0) return docs;
    // Fallback: staging holds docs from a redirected landing URL that no
    // longer matches startUrls — use everything, newest first, and say so.
    const all = await RawDocument.find({}).sort({ fetchedAt: -1 }).lean();
    return all.map((doc) => ({ ...doc, _fallbackSource: true }));
  } finally {
    await connection.close();
  }
}

function deriveYearCycle(docs, startDate, endDate, options) {
  const year =
    options.year ||
    (startDate && startDate.getUTCFullYear()) ||
    (endDate && endDate.getUTCFullYear()) ||
    (docs.length > 0 && docs[0].fetchedAt
      ? new Date(docs[0].fetchedAt).getUTCFullYear()
      : new Date().getUTCFullYear());
  const cycle = options.cycle || String(year);
  return { year, cycle };
}

async function runExtractionPipeline(adapterConfig, options = {}) {
  const adapter = SourceAdapterConfigSchema.parse(adapterConfig);
  const docs = await loadStagedDocuments(adapter, options);
  const usedFallback =
    docs.length > 0 && docs.every((doc) => doc._fallbackSource === true);
  const cleanDocs = docs.map((doc) => {
    const { _fallbackSource, ...rest } = doc;
    return rest;
  });

  // 1. Text preparation: one prepared text per staged document. The
  //    validated adapter travels with each call so PDF cleaning uses the
  //    source's own cleanPatterns.
  const prepared = [];
  for (const doc of cleanDocs) {
    const text = await prepareText(doc, options, adapter);
    prepared.push({ doc, text });
  }
  const combinedText = prepared.map((p) => p.text).filter(Boolean).join("\n\n");
  const stats = {
    textChars: combinedText.length,
    sources: prepared.length,
  };

  // 2. Extraction over each document (per-doc evidence), merged newest-first:
  //    the first confident finding wins per field; UNKNOWN fills the rest.
  let startDate = null;
  let endDate = null;
  const sources = [];
  for (const { doc, text } of prepared) {
    const found = extractRegistrationDates(text, docProvenance(doc));
    if (!startDate && found.startDate) {
      startDate = found.startDate;
      sources.push(...found.findings.filter((f) => f.kind === "start").map((f) => f.evidence));
    } else if (!startDate) {
      // No date adopted: preserve competing-date evidence for the UNKNOWN
      // field instead of dropping the ambiguity (mirrors the
      // informative-unknown merge below).
      sources.push(...found.findings.filter((f) => f.kind === "start").map((f) => f.evidence));
    }
    if (!endDate && found.endDate) {
      endDate = found.endDate;
      sources.push(...found.findings.filter((f) => f.kind === "end").map((f) => f.evidence));
    } else if (!endDate) {
      sources.push(...found.findings.filter((f) => f.kind === "end").map((f) => f.evidence));
    }
    if (startDate && endDate) break;
  }

  // 3. Eligibility: merge per-axis newest-first — an axis stays at the first
  //    document that evidences it; the rest remain UNKNOWN. An UNKNOWN axis
  //    that carries evidence (e.g. multi-category ambiguity) is informative
  //    too, so it is adopted when the current axis has no evidence yet.
  //    Stream/subject recognition comes from the adapter vocabularies.
  let eligibility = buildUnknownEligibility();
  const axisEvidence = {};
  const vocab = {
    subjectVocabulary: adapter.subjectVocabulary,
    streamVocabulary: adapter.streamVocabulary,
  };
  for (const { doc, text } of prepared) {
    const candidate = extractEligibility(text, docProvenance(doc), vocab);
    for (const axis of Object.keys(eligibility)) {
      const current = eligibility[axis];
      const incoming = candidate[axis];
      const informativeUnknown =
        incoming.status === "UNKNOWN" &&
        incoming.evidence &&
        !current.evidence;
      if (
        (current.status === "UNKNOWN" && incoming.status !== "UNKNOWN") ||
        informativeUnknown
      ) {
        eligibility[axis] = incoming;
        axisEvidence[axis] = incoming.evidence;
      }
    }
    if (Object.values(eligibility).every((axis) => axis.status !== "UNKNOWN")) break;
  }
  for (const evidence of Object.values(axisEvidence)) {
    if (evidence) sources.push(evidence);
  }

  // 4. Edition identity + assembly (DRAFT only, nulls where unknown).
  const { year, cycle } = deriveYearCycle(cleanDocs, startDate, endDate, options);

  const exam = {
    slug: adapter.slug,
    name: adapter.name,
    fullForm: adapter.fullForm,
    conductingBody: adapter.conductingBody,
    officialWebsite: adapter.officialWebsite,
    careerType: null,
    examType: null,
  };

  const edition = {
    examSlug: adapter.slug,
    year,
    cycle,
    registration: { startDate, endDate },
    eligibility,
    sources,
    status: "DRAFT",
  };

  // 5. Validation: fail loudly — never return a quiet invalid draft.
  const examCheck = validateExam(exam);
  const editionCheck = validateExamEdition(edition);
  if (!examCheck.success || !editionCheck.success) {
    throw new Error(
      "extractionPipeline: invalid draft — " +
        JSON.stringify(
          {
            exam: examCheck.success ? null : examCheck.error.issues,
            edition: editionCheck.success ? null : editionCheck.error.issues,
          },
          null,
          2
        )
    );
  }

  return {
    adapter: adapter.slug,
    year,
    cycle,
    documents: cleanDocs.map((doc) => ({
      label: doc.label,
      url: doc.url,
      type: doc.type,
      excerpt: excerptOf(
        prepared.find((p) => p.doc.url === doc.url)?.text
      ),
    })),
    exam,
    edition,
    validation: { examOk: true, editionOk: true },
    stats,
    ...(usedFallback ? { fallbackSources: true } : {}),
  };
}

module.exports = {
  runExtractionPipeline,
  prepareText,
  EXCERPT_CHARS,
};
