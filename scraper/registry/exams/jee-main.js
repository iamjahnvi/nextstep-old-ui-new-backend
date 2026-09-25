// =============================================================================
// scraper/registry/exams/jee-main.js
// =============================================================================
// WHAT: JEE Main source adapter — CONFIGURATION ONLY. No scraping logic here.
// WHY: All JEE-specific knowledge lives in this one declarative file. The
//   generic engine (fetchers / parsers / extractors / validators) reads it and
//   does the work, so adding the next exam means adding a config, not a scraper.
// VALUE PROVENANCE (moved out of code, nothing invented):
//   - officialWebsite / startUrls  <- scraper/index.js (hardcoded axios URL)
//   - fullForm / conductingBody    <- scraper/extractors/basicInfo.js
//   - descriptionExclusions        <- basicInfo.js paragraph filter
//   - footerExclusions             <- scraper/parsers/htmlParser.js filters
//   - docRules                     <- scraper/extractors/documentLinks.js phrase
//   - sections                     <- scraper/index.js PDF section markers
//   - cleanPatterns                <- scraper/normalizers/pdfText.js (as regex
//                                     sources; engine compiles them later)
//   - subjectVocabulary/streamVocabulary <- scraper/extractors/eligibility.js
//     (previously hardcoded there; moved here verbatim so behavior is
//     unchanged and other exams never inherit JEE values)
//
// DELIBERATELY ABSENT (product decisions, see Phase 1 report):
//   - careerType / examType: stay null for every exam at this stage.
//   - month: derived from registration dates by the application layer.
// =============================================================================

module.exports = {
  slug: "jee-main",
  // unique short identifier for the exam
  name: "JEE Main",
  fullForm: "Joint Entrance Examination (Main)",
  conductingBody: "National Testing Agency (NTA)",
  officialWebsite: "https://jeemain.nta.nic.in/",

  startUrls: ["https://jeemain.nta.nic.in/"],
  // "js": official site returns HTTP 403 to plain HTTP clients (verified
  // Phase 1 live run), so the engine must use the browser fetcher here.
  // this jee main official website refuses req made by a basic HTTP Client.
  // for example , if our scraper uses something like fetch/axios then it will show this error. on the other hand, chrome/playwright can sometimes access it becz it behaves more like a browser.

  render: "js",
  // js" means use the browser/Playwright fetcher

  docRules: [
    {
      label: "information-bulletin",
      match: ["information bulletin"],
      type: "PDF"
    },
  ],

  // Step 22 allowlist: exact bulletin URLs the operator explicitly trusts.
  // VALUE PROVENANCE (observed live, nothing invented — verified 2026-09-25
  // by fetching https://jeemain.nta.nic.in/ through the browser transport and
  // reading its anchors): the landing exposes an "Information Bulletin" link
  // to this NTA CDN (s3waas.gov.in) PDF. The landing ALSO exposes an older
  // October-2024 upload under the same anchor text; that stale previous-cycle
  // URL is deliberately EXCLUDED — one exact current-cycle URL only.
  // NOTE: the CDN host differs from jeemain.nta.nic.in, so same-domain-only
  // discovery can never find it; the explicit declaration below is the trust
  // decision, and the probe still validates reachability + PDF validity.
  // Re-verify before trusting blindly in a new cycle (paths are opaque).
  bulletinUrls: [
    "https://cdnbbsr.s3waas.gov.in/s3f8e59f4b2fe7c5705bf878bbd494ccdf/uploads/2025/11/202511021649722475.pdf",
  ],

  sections: [
    {
      key: "about",
      start: "1.3 About Joint Entrance Examination (Main) - 2026",
      end: "CHAPTER – 2",
    },
  ],

  cleanPatterns: [
    "-- \\d+ of \\d+ --",
    "राष्ट् र ीय परीक्षा एजेंसी Information Bulletin - 2026",
    "National Testing Agency",
    "Excellence in Assessment",
  ],

  descriptionExclusions: ["Ministry of Education"],

  footerExclusions: ["Content Owned and Maintained", "Designed, Developed"],

  subjectVocabulary: [
    { canonical: "Physics", match: ["physics"] },
    { canonical: "Chemistry", match: ["chemistry"] },
    { canonical: "Mathematics", match: ["mathematics", "maths", "math"] },
    { canonical: "Biology", match: ["biology"] },
    { canonical: "Computer Science", match: ["computer science"] },

    // Canonical generally means the standard, official, or normalized form of something.
  ],

  streamVocabulary: [{ canonical: "Science", match: ["science stream"] }],
};
