// =============================================================================
// scraper/registry/exams/jee-advanced.js
// =============================================================================
// WHAT: JEE Advanced source adapter — CONFIGURATION ONLY. No scraping logic here.
// WHY: Third proof that the generic engine is not exam-specific: this file is
//   the ONLY JEE-Advanced-specific artifact. Fetching, discovery, retrieval,
//   parsing, extraction, staging, review and publish all run through the shared
//   modules driven by the fields below.
//
// WHY THIS EXAM (Phase 27 selection — meaningfully different from JEE/GATE):
//   - Different board: IIT Roorkee (2026 organizer), not NTA, not IIT Guwahati.
//   - Gated, multi-criterion eligibility (JEE Main rank + age limit + attempt
//     limit + Class XII appearance) vs JEE's single-bulletin facts and GATE's
//     degree rules — exercises DOB-cutoff age handling and honest UNKNOWNs.
//   - Discovery stress: landing anchors carry generic text ("Link"), so the
//     bulletin is addressable only by URL (matchUrl) — the Phase 27 generic
//     discovery capability, not exam branching.
//
// VALUE PROVENANCE (observed live, nothing invented — verified 2026-09-20
//   via the project's plain static fetcher, HTTP 200):
//   - officialWebsite / startUrls  <- https://jeeadv.ac.in/
//   - fullForm                     <- landing title "JEE (Advanced) 2026"
//   - conductingBody               <- brochure "Organizing Institute: Indian
//                                     Institute of Technology Roorkee"
//   - docRules                     <- landing "Link" -> documents/IBEnglish_2026.pdf
//                                     (addressed by URL: anchor text is generic)
//   - cleanPatterns                <- brochure running header/footer boilerplate
// SOURCE NOTES:
//   - render "static": the site answers plain HTTP 200 with server-rendered
//     HTML (browser needed only for JS-shelled sites, unlike JEE Main).
//   - The Information Brochure (118-page PDF, ~6MB) carries eligibility
//     criteria A1–A5, including a DOB-based age limit.
// DELIBERATELY ABSENT (same product decisions as every adapter):
//   - careerType / examType: stay null; the scraper must not classify them.
//   - month: derived from registration dates by the application layer.
// =============================================================================

module.exports = {
  slug: "jee-advanced",
  name: "JEE Advanced",
  fullForm: "Joint Entrance Examination (Advanced)",
  conductingBody: "Indian Institute of Technology Roorkee",
  officialWebsite: "https://jeeadv.ac.in/",

  startUrls: ["https://jeeadv.ac.in/"],
  render: "static",
  
  // jeeadv.ac.in returns server-rendered HTML on plain HTTP 200 (verified 2026-09-20) — no JS shell, so no Playwright needed. Unlike JEE Main.jeeadv.ac.in returns server-rendered HTML on plain HTTP 200 (verified 2026-09-20) — no JS shell, so no Playwright needed. Unlike JEE Main.

  docRules: [
    {
      label: "information-bulletin",
      // Landing anchors carry no usable text (bare "Link"), so address the
      // bulletin by its stable URL stem. Text phrases kept as documentation
      // of what the document is.
      match: ["information bulletin"],
      matchUrl: ["IBEnglish"],
      type: "PDF",
    },
  ],

  sections: [],

  cleanPatterns: [
    "-- \\d+ of \\d+ --",
    "© JEE \\(Advanced\\) 2026 – Information Brochure",
    "https://jeeadv.ac.in",
  ],

  descriptionExclusions: [],

  footerExclusions: [],

  // Streams/subjects are not eligibility requirements here (criterion-based
  // admission: rank, age, attempts, Class XII appearance). Empty vocabularies
  // keep those axes honestly UNKNOWN instead of inheriting JEE Main values.
  subjectVocabulary: [],

  streamVocabulary: [],
};
