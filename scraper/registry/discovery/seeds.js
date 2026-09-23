// =============================================================================
// scraper/registry/discovery/seeds.js
// =============================================================================
// WHAT: Discovery seed configuration — CONFIGURATION ONLY, no scraping logic.
//   Seeds are starting points the exam-discovery layer reads to find candidate
//   exams. The engine (discovery/examDiscovery.js) is generic: it reads these
//   seeds, never branches on exam identity, and never invents sources.
// WHY: Discovery must be configuration-driven and multi-source from day one:
//   no single website contains every exam, so the architecture supports seed
//   types (authority homepages today; directory/calendar types reserved for
//   future verified additions) with per-seed deterministic match rules.
// VALUE PROVENANCE (nothing invented — every enabled URL already exists in
//   this repository):
//   - jee-main-authority / gate-2026-authority / jee-advanced-authority <-
//     scraper/registry/exams/{jee-main,gate-2026,jee-advanced}.js
//     (officialWebsite values the scraper has fetched live in past phases).
//   - upsc-authority / neet-authority <- server/data/exams.js officialWebsite
//     values (NextStep's own exam records; reused here ONLY as starting
//     points — a seed URL is not a verification claim, see below).
// SEED ≠ VERIFICATION: listing a URL here claims nothing about officiality.
//   Seeds produce DISCOVERED candidates with evidence; source verification is
//   a separate future step that must independently prove authority.
// RULES (regex *sources*, compiled by the engine — same serializable-config
//   convention as registry cleanPatterns):
//   - includePatterns: generic English exam-opportunity signals (word-boundary
//     anchored so "exam" never matches "example"). No exam names, ever.
//   - excludePatterns: obvious non-exam boilerplate (auth/portal chrome).
// =============================================================================

const { z } = require("zod");

const SeedTypeSchema = z.enum(["authority", "directory", "calendar"]);

const SeedRulesSchema = z
  .object({
    includePatterns: z.array(z.string().min(1)).min(1),
    excludePatterns: z.array(z.string().min(1)).default([]),
    maxCandidates: z.number().int().min(1).max(500).default(50),
  })
  .strict();

const DiscoverySeedSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    label: z.string().min(1),
    url: z.url(),
    type: SeedTypeSchema,
    enabled: z.boolean().default(true),
    notes: z.string().default(""),
    rules: SeedRulesSchema,
  })
  .strict();

// Generic opportunity signals shared by authority seeds. Kept in one place so
// new seeds reuse them instead of re-declaring phrases; a seed may still
// override rules entirely when its page structure genuinely differs.
const DEFAULT_INCLUDE_PATTERNS = [
  "\\bexaminations?\\b",
  "\\bentrance\\b",
  "\\badmissions?\\b",
  "\\brecruitments?\\b",
  "\\bnotifications?\\b",
];

const DEFAULT_EXCLUDE_PATTERNS = [
  "\\blog\\s?in\\b",
  "\\bregister\\b",
  "\\bcontact\\s?us\\b",
  "\\btenders?\\b",
];

const SEEDS = [
  {
    id: "jee-main-authority",
    label: "JEE Main official site (NTA)",
    url: "https://jeemain.nta.nic.in/",
    type: "authority",
    enabled: true,
    notes: "Scraper-verified live source (registry/exams/jee-main.js).",
    rules: {
      includePatterns: DEFAULT_INCLUDE_PATTERNS,
      excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
      maxCandidates: 50,
    },
  },
  {
    id: "gate-2026-authority",
    label: "GATE 2026 official site (IIT Guwahati)",
    url: "https://gate2026.iitg.ac.in/",
    type: "authority",
    enabled: true,
    notes: "Scraper-verified live source (registry/exams/gate-2026.js).",
    rules: {
      includePatterns: DEFAULT_INCLUDE_PATTERNS,
      excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
      maxCandidates: 50,
    },
  },
  {
    id: "jee-advanced-authority",
    label: "JEE Advanced official site (IIT Roorkee 2026)",
    url: "https://jeeadv.ac.in/",
    type: "authority",
    enabled: true,
    notes: "Scraper-verified live source (registry/exams/jee-advanced.js).",
    rules: {
      includePatterns: DEFAULT_INCLUDE_PATTERNS,
      excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
      maxCandidates: 50,
    },
  },
  {
    id: "upsc-authority",
    label: "UPSC official site",
    url: "https://upsc.gov.in/",
    type: "authority",
    enabled: true,
    notes: "Reused from server/data/exams.js officialWebsite. Seed only.",
    rules: {
      includePatterns: DEFAULT_INCLUDE_PATTERNS,
      excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
      maxCandidates: 50,
    },
  },
  {
    id: "neet-authority",
    label: "NEET official site (NTA)",
    url: "https://neet.nta.nic.in/",
    type: "authority",
    enabled: true,
    notes: "Reused from server/data/exams.js officialWebsite. Seed only.",
    rules: {
      includePatterns: DEFAULT_INCLUDE_PATTERNS,
      excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
      maxCandidates: 50,
    },
  },
];

function validateSeeds(seeds = SEEDS) {
  return z.array(DiscoverySeedSchema).safeParse(seeds);
}

function getEnabledSeeds(seeds = SEEDS) {
  const parsed = z.array(DiscoverySeedSchema).parse(seeds);
  return parsed.filter((seed) => seed.enabled);
}

module.exports = {
  SeedTypeSchema,
  SeedRulesSchema,
  DiscoverySeedSchema,
  DEFAULT_INCLUDE_PATTERNS,
  DEFAULT_EXCLUDE_PATTERNS,
  SEEDS,
  validateSeeds,
  getEnabledSeeds,
};
