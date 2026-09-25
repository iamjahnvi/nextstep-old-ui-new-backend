// =============================================================================
// scraper/models/examCandidate.js
// =============================================================================
// WHAT: Mongoose schema for discovered exam candidates — "we found something
//   that looks like an exam opportunity, but we have NOT verified it yet."
//   This is deliberately a different concept from:
//     ExamEditionDraft = crawled + extracted structured exam data (staging),
//     Exam             = verified + published NextStep data (production).
// ISOLATION: documents live in the `scraper_exam_candidates` collection,
//   unrelated to `scraper_editiondrafts` and to production `exams`. Nothing
//   here imports server code, and no publish path accepts this model (the
//   publish executor's collection guards refuse anything but staging drafts
//   and the production exams collection — locked by tests).
// STATUS: DISCOVERED only in Step 2. FUTURE_CANDIDATE_STATUSES names the
//   lifecycle later steps may introduce (verification → profiling → crawling
//   → extraction → review → publish); the schema enum stays DISCOVERED-only
//   until those steps land, so no candidate can arrive pre-verified.
// WHY per-connection factory: same convention as models/rawDocument.js — the
//   service opens its own connection and must not clash with host app models.
// =============================================================================

const mongoose = require("mongoose");

const EXAM_CANDIDATE_COLLECTION = "scraper_exam_candidates";

// Step 3 reality: discovery creates DISCOVERED candidates; source
// verification advances them to SOURCE_VERIFIED or SOURCE_REVIEW_REQUIRED
// (discovery/sourceVerification.js only — never by discovery itself).
const CANDIDATE_STATUSES = ["DISCOVERED", "SOURCE_VERIFIED", "SOURCE_REVIEW_REQUIRED"];

// Lifecycle design for later steps (Step 4+). Listed here so future states
// slot into the schema enum cleanly; NOT assignable by any current code path.
const FUTURE_CANDIDATE_STATUSES = [
  "PROFILED",
  "CRAWLED",
  "EXTRACTED",
  "REVIEW",
  "VERIFIED",
  "PUBLISHED",
  "REJECTED",
];

// One discovery sighting: why this candidate exists. No officiality claims —
// a seed URL is a starting point, never proof of authority.
const discoveryEvidenceSchema = new mongoose.Schema(
  {
    seedId: { type: String, required: true, trim: true },
    sourceUrl: { type: String, required: true, trim: true },
    sourceTitle: { type: String, default: null },
    matchedText: { type: String, required: true, trim: true },
    matchedUrl: { type: String, default: null },
    matchedPattern: { type: String, required: true, trim: true },
    retrievedAt: { type: Date, required: true },
  },
  { _id: false }
);

const examCandidateSchema = new mongoose.Schema(
  {
    // Deterministic identity: hash(normalized name | year-or-unknown).
    // Same exam re-sighted (same or different seed) reuses one document with
    // appended evidence; different names/years stay separate. Never invented:
    // unknown year/conducting body stay null, never guessed.
    candidateId: { type: String, required: true, trim: true, unique: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: null },
    conductingBody: { type: String, default: null },
    examUrl: { type: String, default: null },
    edition: { type: String, default: null },
    year: { type: Number, default: null },
    sourceUrl: { type: String, required: true, trim: true },
    sourceDomain: { type: String, required: true, trim: true },
    discoverySource: { type: String, required: true, trim: true },
    discoverySources: { type: [String], default: [] },
    discoveredAt: { type: Date, required: true },
    lastSeenAt: { type: Date, default: null },
    status: { type: String, required: true, enum: CANDIDATE_STATUSES, default: "DISCOVERED" },
    evidence: { type: [discoveryEvidenceSchema], default: [] },
  },
  { timestamps: true }
);

examCandidateSchema.index({ status: 1 });
examCandidateSchema.index({ sourceDomain: 1 });

function getExamCandidateModel(connection) {
  if (!connection || typeof connection.model !== "function") {
    throw new Error("getExamCandidateModel: a mongoose connection is required");
  }
  return connection.model(
    "ScraperExamCandidate",
    examCandidateSchema,
    EXAM_CANDIDATE_COLLECTION
  );
}

module.exports = {
  EXAM_CANDIDATE_COLLECTION,
  CANDIDATE_STATUSES,
  FUTURE_CANDIDATE_STATUSES,
  examCandidateSchema,
  discoveryEvidenceSchema,
  getExamCandidateModel,
};
