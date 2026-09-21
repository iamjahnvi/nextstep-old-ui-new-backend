// =============================================================================
// scraper/extractors/evidence.js
// =============================================================================
// WHAT: Shared Evidence-object builder for the extraction layer.
// WHY: Every extracted fact must carry provenance shaped exactly like
//   validators/examValidator.js EvidenceSchema (strict: no extra keys).
//   One helper keeps extractor tags consistent and excerpts print-safe.
// CONTRACT:
//   buildEvidence(ctx, { confidence, excerpt, section })
//     ctx: { sourceUrl, documentUrl, docType, retrievedAt, section?,
//            extractor } — per-document provenance from the pipeline.
//   Returns an Evidence object (excerpt trimmed to 500 chars).
// =============================================================================

function buildEvidence(ctx, finding = {}) {
  if (!ctx || typeof ctx.sourceUrl !== "string") {
    throw new Error("evidence: sourceUrl is required");
  }
  const excerpt =
    typeof finding.excerpt === "string"
      ? finding.excerpt.replace(/\s+/g, " ").trim().slice(0, 500) || null
      : null;
  return {
    sourceUrl: ctx.sourceUrl,
    documentUrl:
      typeof ctx.documentUrl === "string" ? ctx.documentUrl : null,
    docType: ctx.docType || "OTHER",
    retrievedAt:
      ctx.retrievedAt instanceof Date ? ctx.retrievedAt : new Date(ctx.retrievedAt),
    section: finding.section || ctx.section || null,
    page: null,
    excerpt,
    confidence: finding.confidence || "LOW",
    extractor: ctx.extractor || null,
  };
}

module.exports = {
  buildEvidence,
};
