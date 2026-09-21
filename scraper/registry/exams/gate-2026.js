// =============================================================================
// scraper/registry/exams/gate-2026.js
// =============================================================================
// WHAT: GATE 2026 source adapter — CONFIGURATION ONLY. No scraping logic here.
// WHY: Second proof that the generic engine is not JEE-specific: this file is
//   the ONLY GATE-specific artifact. Fetching, discovery, retrieval, parsing,
//   extraction, staging, review and publish all run through the shared
//   modules driven by the fields below.
// VALUE PROVENANCE (observed live, nothing invented — verified 2026-09-20
//   via the project's plain static fetcher, HTTP 200):
//   - officialWebsite / startUrls  <- https://gate2026.iitg.ac.in/
//   - fullForm                     <- landing "GRADUATE APTITUDE TEST IN ENGINEERING 2026"
//   - conductingBody               <- landing "Organizing Institute: INDIAN
//                                     INSTITUTE OF TECHNOLOGY GUWAHATI"
//   - docRules                     <- landing links "Eligibility Criteria"
//                                     (-> eligibility-criteria.html),
//                                     "Important Dates" (-> important-dates.html)
//   - descriptionExclusions        <- site footer boilerplate
// SOURCE NOTES:
//   - render "static": the site answers plain HTTP 200 with server-rendered
//     HTML (unlike the JEE site, no browser needed).
//   - Key facts live in an HTML <table> on important-dates.html (registration
//     window) and in <p> text on eligibility-criteria.html (degree rules).
// DELIBERATELY ABSENT (same product decisions as every adapter):
//   - careerType / examType: stay null; the scraper must not classify them.
//   - month: derived from registration dates by the application layer.
// =============================================================================

module.exports = {
  slug: "gate-2026",
  name: "GATE 2026",
  fullForm: "Graduate Aptitude Test in Engineering 2026",
  conductingBody: "Indian Institute of Technology Guwahati",
  officialWebsite: "https://gate2026.iitg.ac.in/",

  startUrls: ["https://gate2026.iitg.ac.in/"],
  render: "static",

  docRules: [
    { label: "eligibility", match: ["eligibility criteria"], type: "HTML" },
    { label: "important-dates", match: ["important dates"], type: "HTML" },
  ],

  sections: [],

  cleanPatterns: [],

  descriptionExclusions: ["All Rights Reserved"],

  footerExclusions: [],

  // GATE eligibility hinges on degree level, not school streams/subjects,
  // so both vocabularies stay empty: those axes remain UNKNOWN rather than
  // inheriting any other exam's values.
  subjectVocabulary: [],

  streamVocabulary: [],
};
