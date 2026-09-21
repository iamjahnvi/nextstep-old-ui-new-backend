// =============================================================================
// scraper/publish/publishValidator.js
// =============================================================================
// WHAT: Validates a mapped publish payload against the NextStep Exam
//   requirements (mirrored from server/models/Exam.js — local zod schema, no
//   server imports) plus the publish gate (draft must be VERIFIED).
// WHY: The production schema is NOT weakened: required fields stay required.
//   A VERIFIED draft with UNKNOWN essentials (null dates, null education) is
//   still unpublishable — the validator rejects it with useful errors instead
//   of letting nulls reach production.
// REJECTS:
//   - non-VERIFIED drafts (DRAFT, REJECTED, missing status)
//   - malformed required fields (empty name/fullForm/website, empty streams or
//     subjects arrays — the Exam schema requires all of these)
//   - invalid dates (unparseable, or end before start)
//   - invalid education/eligibility values (unknown level, percentage outside
//     0–100, negative age)
//   - any `month` key or other unrecognized exam key (.strict())
// CONTRACT:
//   validatePublishRequest({ draft, payload })
//     -> { ok: true, value } | { ok: false, issues: { status?, exam?, evidence? } }.
//   Never throws on invalid data (only on missing arguments) — the service
//   turns issues into a clear error.
// =============================================================================

const { z } = require("zod");
const { validateEvidence } = require("../validators/examValidator");

// Canonical levels mirror server/utils/educationLevels.js ALLOWED_EDUCATION_LEVELS.
const PUBLISH_EDUCATION_LEVELS = [
  "8",
  "9",
  "10",
  "11",
  "12",
  "Graduate",
  "Post-Graduate",
  "Doctorate",
];

// NOTE: required dates deliberately avoid z.coerce.date() — coercion turns
// null into the Unix epoch (new Date(null)), which would let missing dates
// slip through as 1970-01-01. This type accepts real Dates and non-empty
// parseable strings only.
const RequiredDate = z
  .union([
    z.date(),
    z
      .string()
      .min(1)
      .refine((s) => !Number.isNaN(new Date(s).getTime()), {
        message: "invalid date",
      }),
  ])
  .transform((v) => (v instanceof Date ? v : new Date(v)))
  .refine((d) => !Number.isNaN(d.getTime()), { message: "invalid date" });

const PublishExamSchema = z
  .object({
    name: z.string().min(1),
    fullForm: z.string().min(1),
    description: z.string().nullable().optional(),
    minimumAge: z.number().int().min(0).nullable(),
    minimumEducationLevel: z.enum(PUBLISH_EDUCATION_LEVELS),
    streams: z.array(z.string().min(1)).min(1),
    subjects: z.array(z.string().min(1)).min(1),
    eligibility: z
      .object({
        minimumPercentage: z.number().min(0).max(100).nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    registrationStartDate: RequiredDate,
    registrationEndDate: RequiredDate,
    officialWebsite: z.url(),
    // Unclassified by product decision — null only (never a guessed value).
    careerType: z.null(),
    examType: z.null(),
    // NOTE: no `month` by design (.strict() rejects it).
  })
  .strict()
  .refine(
    (exam) => exam.registrationEndDate >= exam.registrationStartDate,
    { message: "registrationEndDate must be >= registrationStartDate" }
  );

function validatePublishRequest({ draft, payload } = {}) {
  if (!draft || !payload) {
    throw new Error("publishValidator: draft and payload are required");
  }
  const issues = {};

  if (draft.status !== "VERIFIED") {
    issues.status = [
      {
        message: `only VERIFIED drafts are publishable (status is ${draft.status ?? "missing"})`,
      },
    ];
  }

  const parsed = PublishExamSchema.safeParse(payload);
  if (!parsed.success) {
    issues.exam = parsed.error.issues;
  }

  const evidence = draft.edition && draft.edition.sources;
  if (!Array.isArray(evidence)) {
    issues.evidence = [{ message: "evidence must remain attached" }];
  } else {
    const bad = [];
    evidence.forEach((source, index) => {
      if (!validateEvidence(source).success) bad.push(index);
    });
    if (bad.length > 0) {
      issues.evidence = [{ message: `invalid evidence entries at indexes ${bad.join(", ")}` }];
    }
  }

  if (Object.keys(issues).length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: parsed.data };
}

module.exports = {
  PUBLISH_EDUCATION_LEVELS,
  PublishExamSchema,
  validatePublishRequest,
};
