// =============================================================================
// scraper/validators/examValidator.js
// =============================================================================
// WHAT: Draft Zod schemas for the canonical ingestion output.
// WHY: Validation is what stops scraped text from becoming unquestioned truth.
//   Every pipeline result is checked here before it may reach staging storage.
//   Nothing here writes to MongoDB and nothing touches the demo `exams` data.
//
// DESIGN DECISIONS (product constraints, see Phase 1 report):
//   - careerType / examType are NULLABLE and optional. They stay null for every
//     exam at this stage; the scraper must not classify them.
//   - There is NO month field (schemas are .strict(), so `month` is REJECTED).
//     Month relevance derives from registration dates in the app layer.
//   - Eligibility is tri-state per axis: KNOWN | UNKNOWN | NEEDS_VERIFICATION.
//     Missing information is UNKNOWN (never auto "not eligible"). Values stay
//     null until positively evidenced by an official source.
//   - Exam  = stable identity (one doc per exam).
//     ExamEdition = one doc per exam per year/cycle (dates, eligibility, fees
//     change between editions).
// =============================================================================

const { z } = require("zod");

// --- Shared vocab ------------------------------------------------------------

const EligibilityStatusSchema = z.enum([
  "KNOWN",
  "UNKNOWN",
  "NEEDS_VERIFICATION",
]);

const ConfidenceSchema = z.enum(["HIGH", "MEDIUM", "LOW"]);

const DocTypeSchema = z.enum(["HTML", "PDF", "OTHER"]);

// --- Evidence / provenance ---------------------------------------------------
// Where one extracted fact came from: official URL, document, retrieval time,
// and the source excerpt where practical.
const EvidenceSchema = z
  .object({
    sourceUrl: z.url(),
    documentUrl: z.url().nullable().optional(),
    docType: DocTypeSchema,
    retrievedAt: z.coerce.date(),
    section: z.string().nullable().optional(),
    page: z.string().nullable().optional(),
    excerpt: z.string().nullable().optional(),
    confidence: ConfidenceSchema,
    extractor: z.string().nullable().optional(),
  })
  .strict();

// --- Eligibility (tri-state per axis) ----------------------------------------
// Each axis carries its value (null until evidenced) + status + evidence.
// `status` + `value` must agree: KNOWN requires a value; UNKNOWN /
// NEEDS_VERIFICATION must not claim one. (NEEDS_VERIFICATION may still carry
// a low-confidence candidate value alongside the flag.)
const statusAndEvidence = {
  status: EligibilityStatusSchema,
  evidence: EvidenceSchema.nullable().optional(),
};

const EligibilitySchema = z
  .object({
    education: z
      .object({
        minLevel: z.string().nullable(),
        maxLevel: z.string().nullable(),
        appearingAllowed: z.boolean().nullable(),
        ...statusAndEvidence,
      })
      .strict()
      .refine(
        (v) =>
          v.status !== "KNOWN" ||
          (v.minLevel !== null &&
            v.minLevel !== undefined &&
            v.minLevel !== ""),
        { message: "education: KNOWN requires a minLevel value" }
      ),
    stream: z
      .object({
        allowed: z.array(z.string()).nullable(),
        ...statusAndEvidence,
      })
      .strict()
      .refine((v) => v.status !== "KNOWN" || v.allowed !== null, {
        message: "stream: KNOWN requires an allowed value",
      }),
    subjects: z
      .object({
        requiredAny: z.array(z.string()).nullable(),
        ...statusAndEvidence,
      })
      .strict()
      .refine((v) => v.status !== "KNOWN" || v.requiredAny !== null, {
        message: "subjects: KNOWN requires a requiredAny value",
      }),
    percentage: z
      .object({
        min: z.number().min(0).max(100).nullable(),
        ...statusAndEvidence,
      })
      .strict()
      .refine((v) => v.status !== "KNOWN" || v.min !== null, {
        message: "percentage: KNOWN requires a min value",
      }),
    age: z
      .object({
        min: z.number().int().min(0).nullable(),
        max: z.number().int().min(0).nullable(),
        asOfDate: z.coerce.date().nullable(),
        ...statusAndEvidence,
      })
      .strict()
      .refine((v) => v.status !== "KNOWN" || v.min !== null || v.max !== null, {
        message: "age: KNOWN requires a min or max value",
      }),
  })
  .strict();

// All-UNKNOWN skeleton: the honest starting point before extraction evidences
// anything. Missing info stays UNKNOWN — never "not eligible".
function buildUnknownEligibility() {
  const unknown = (value) => ({
    ...value,
    status: "UNKNOWN",
    evidence: null,
  });
  return {
    education: unknown({ minLevel: null, maxLevel: null, appearingAllowed: null }),
    stream: unknown({ allowed: null }),
    subjects: unknown({ requiredAny: null }),
    percentage: unknown({ min: null }),
    age: unknown({ min: null, max: null, asOfDate: null }),
  };
}

// --- Exam (stable identity) ---------------------------------------------------

const ExamSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1),
    fullForm: z.string().min(1),
    conductingBody: z.string().min(1),
    officialWebsite: z.url(),
    // Nullable on purpose: unclassified at this stage, never invented.
    careerType: z.string().nullable().optional(),
    examType: z.string().nullable().optional(),
    // NOTE: no `month` field by design (.strict() rejects it).
  })
  .strict();

// --- ExamEdition (one per exam per year/cycle) --------------------------------

const ExamEditionSchema = z
  .object({
    examSlug: z.string().min(1),
    year: z.number().int(),
    cycle: z.string().min(1),
    registration: z
      .object({
        startDate: z.coerce.date().nullable(),
        endDate: z.coerce.date().nullable(),
      })
      .strict()
      .refine(
        (r) =>
          r.startDate === null ||
          r.endDate === null ||
          r.startDate <= r.endDate,
        { message: "registration: startDate must be <= endDate" }
      ),
    eligibility: EligibilitySchema,
    sources: z.array(EvidenceSchema),
    status: z.enum(["DRAFT", "VERIFIED"]),
    // NOTE: no `month` field by design (.strict() rejects it).
  })
  .strict();

function validateExam(doc) {
  return ExamSchema.safeParse(doc);
}

function validateExamEdition(doc) {
  return ExamEditionSchema.safeParse(doc);
}

function validateEvidence(doc) {
  return EvidenceSchema.safeParse(doc);
}

module.exports = {
  EligibilityStatusSchema,
  ConfidenceSchema,
  DocTypeSchema,
  EvidenceSchema,
  EligibilitySchema,
  ExamSchema,
  ExamEditionSchema,
  buildUnknownEligibility,
  validateExam,
  validateExamEdition,
  validateEvidence,
};
