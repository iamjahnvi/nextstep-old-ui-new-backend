// =============================================================================
// scraper/registry/schema.js
// =============================================================================
// WHAT: Zod schema for a source adapter configuration object.
// WHY: The registry (registry/exams/*.js) must stay declarative — plain data,
//   no scraping logic. This schema is the contract the generic engine validates
//   every adapter against at startup (fail fast on bad config, before any HTTP).
// NOTES:
//   - careerType / examType are deliberately ABSENT from the adapter schema.
//     Per product decision they stay null for every exam at this stage; the
//     scraper must not classify them.
//   - There is deliberately NO month field. Month relevance is derived from
//     registration dates by the application layer (see server/utils/discovery.js).
//   - cleanPatterns are regex *sources* (strings), not RegExp objects, so the
//     config stays serializable. The engine compiles them later.
// =============================================================================

const { z } = require("zod");

// One named document to look for among page links, e.g. the information bulletin.
// `match` phrases are case-insensitive substrings matched against link text;
// `matchUrl` phrases are case-insensitive substrings matched against the
// resolved absolute URL (for icon-only or generically-worded anchors such as
// "Link" or "click here", where text carries no signal). A rule matches when
// either side hits; at least one side must be non-empty.
// `type` is an optional retrieval hint; when omitted the engine sniffs the URL
// (.pdf → PDF) and defaults to HTML.
const DocRuleSchema = z
  .object({

    label: z.string().min(1),
    // the value of label must be a string and it's minimum value should be 1 char, atleast.

    match: z.array(z.string().min(1)).default([]),

    matchUrl: z.array(z.string().min(1)).default([]),

    type: z.enum(["HTML", "PDF", "OTHER"]).optional(),
    // .enum means the value must be one of the listed options.
  })

  .strict()
  // we write .strict() because it tells zod to reject extra fields that i didn't define in the zod-schema.

  .refine((rule) => rule.match.length + rule.matchUrl.length > 0, {
    message: "docRule needs at least one match or matchUrl phrase",
  });
  // .refine means after checking the normal rules, also check one extra my own customised rule.

// One vocabulary entry for eligibility extraction: the canonical value the
// engine records, plus the case-insensitive substring phrases that evidence
// it in source text. Serializable plain data — the engine compiles the
// matching itself, so future exams extend vocabularies here without code.
const VocabEntrySchema = z
  .object({
    canonical: z.string().min(1),
    match: z.array(z.string().min(1)).min(1),
  })
  .strict();

// One named section to slice out of a document's text (e.g. a PDF chapter).
const SectionRuleSchema = z
  .object({
    key: z.string().min(1),
    start: z.string().min(1),
    end: z.string().min(1),
  })
  .strict();

// Crawl politeness per source. All three are optional (null = keep the
// fetcher's own default, so adapters that omit `crawl` behave exactly as
// before): delay between consecutive requests, per-request timeout, and
// bounded retry count. Bounds keep every value safe by construction. The
// default is written out literally so a missing key parses to the same
// null-filled object as an explicit `crawl: {}`.
const CrawlConfigSchema = z
  .object({

    requestDelayMs: z.number().int().min(0).max(60000).nullable().default(null),
    // How many milliseconds to wait between requests.
    
    timeoutMs: z.number().int().min(1000).max(120000).nullable().default(null),
    // How many milliseconds to wait between requests.

    maxRetries: z.number().int().min(0).max(5).nullable().default(null),
    // How many times to retry if a request fails.
  })
  .strict()
  .default({ requestDelayMs: null, timeoutMs: null, maxRetries: null });

  // CrawlConfigSchema is basically the rulebook for crawling/fetching settings.

const SourceAdapterConfigSchema = z
  .object({
    // Stable exam identity (facts about the exam itself, not one edition).
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1),
    fullForm: z.string().min(1),
    conductingBody: z.string().min(1),
    officialWebsite: z.url(),

    // Where to start crawling. First entry is the primary landing page.
    startUrls: z.array(z.url()).min(1),

    // "static" = plain HTTP + Cheerio. "js" = Playwright-rendered fetch.
    // Engine uses the browser fetcher ONLY when an adapter asks for "js".
    render: z.enum(["static", "js"]).default("static"),

    // Genuinely per-source differences: which documents, which sections,
    // which noise patterns, which boilerplate to exclude from descriptions,
    // which subject/stream vocabularies eligibility extraction may recognize,
    // and how politely to crawl the source (all crawl fields optional).
    docRules: z.array(DocRuleSchema).default([]),
    sections: z.array(SectionRuleSchema).default([]),
    cleanPatterns: z.array(z.string().min(1)).default([]),
    descriptionExclusions: z.array(z.string().min(1)).default([]),
    footerExclusions: z.array(z.string().min(1)).default([]),
    subjectVocabulary: z.array(VocabEntrySchema).default([]),
    streamVocabulary: z.array(VocabEntrySchema).default([]),
    crawl: CrawlConfigSchema,
  })
  .strict();

function validateAdapterConfig(config) {
  return SourceAdapterConfigSchema.safeParse(config);
}

// It means:

// “Check whether this config follows the rules we defined in SourceAdapterConfigSchema.”
// config → the actual exam configuration, e.g. JEE Main config.
// SourceAdapterConfigSchema → the Zod rulebook.
// .safeParse(config) → validates it without throwing an error

module.exports = {
  DocRuleSchema,
  SectionRuleSchema,
  VocabEntrySchema,
  CrawlConfigSchema,
  SourceAdapterConfigSchema,
  validateAdapterConfig,
};


