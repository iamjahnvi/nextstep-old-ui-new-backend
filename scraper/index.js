// =============================================================================
// scraper/index.js
// =============================================================================
// WHAT: Entry point — JEE reference flow through the generic engine.
// FLOW (Phase 3):
//   JEE registry
//     ↓  fetch official website (strategy from adapter.render)
//   parse HTML
//     ↓  discovery/sourceDiscovery (adapter.docRules, URLs resolved vs page)
//   discover documents (e.g. Information Bulletin)
//     ↓  fetchers/documentFetcher (same render strategy; PDF kept as Buffer)
//   output normalized in-memory RawDocument
//     ↓  STOP — parsing below reuses the retrieved content; no persistence,
//   parse (HTML → htmlParser, PDF → pdfParser) + draft validation, printed.
//   No DB writes, no connection to the recommendation flow, demo data untouched.
// =============================================================================

const jeeAdapterConfig = require("./registry/exams/jee-main");
const { SourceAdapterConfigSchema } = require("./registry/schema");
const { fetchHTML } = require("./fetchers/httpFetcher");
const { fetchViaBrowser } = require("./fetchers/browserFetcher");
const { discoverDocuments } = require("./discovery/sourceDiscovery");
const { fetchDocument } = require("./fetchers/documentFetcher");
const parseHTML = require("./parsers/htmlParser");
const basicInfo = require("./extractors/basicInfo");
const { parsePDFBuffer } = require("./parsers/pdfParser");
const extractSection = require("./extractors/pdfSections");
const cleanPDFText = require("./normalizers/pdfText");
const {
  validateExam,
  validateExamEdition,
  buildUnknownEligibility,
} = require("./validators/examValidator");

// Print-safe RawDocument summary: metadata + size + magic/preview, never a
// full binary dump.
function summarizeRawDocument(doc) {
  const isBuffer = Buffer.isBuffer(doc.content);
  return {
    label: doc.label,
    url: doc.url,
    sourceUrl: doc.sourceUrl,
    type: doc.type,
    fetchedAt: doc.fetchedAt,
    status: doc.status,
    contentType: doc.contentType,
    contentKind: isBuffer ? "Buffer" : typeof doc.content,
    contentLength: isBuffer ? doc.content.length : String(doc.content).length,
    head: isBuffer
      ? doc.content.slice(0, 8).toString("latin1")
      : String(doc.content).slice(0, 200),
  };
}

async function scrape() {
  try {
    // 1. Registry: validate adapter config before doing anything else.
    const adapter = SourceAdapterConfigSchema.parse(jeeAdapterConfig);
    console.log(`Adapter loaded: ${adapter.slug} (${adapter.startUrls.length} start URL)`);

    // 2. Fetch: strategy comes from adapter.render — "static" uses the plain
    //    HTTP fetcher, "js" uses the browser fetcher. Generic dispatch: the
    //    engine never branches on exam identity, only on the render flag.
    const fetchPage = adapter.render === "js" ? fetchViaBrowser : fetchHTML;
    console.log(`Fetch strategy: ${adapter.render}`);
    const page = await fetchPage(adapter.startUrls[0]);
    console.log("Status Code:", page.status);

    // 3. Parse + generic discovery driven by adapter.docRules.
    const data = parseHTML(page.text);
    const discovered = discoverDocuments(data.links, adapter.docRules, page.url);
    console.log(
      "Discovered documents:",
      discovered.map((doc) => ({
        label: doc.label,
        url: doc.url,
        type: doc.type,
      }))
    );

    // 4. Retrieve the Information Bulletin as a normalized RawDocument.
    const bulletinMeta = discovered.find(
      (doc) => doc.label === "information-bulletin"
    ) || null;

    let bulletin = null;
    if (bulletinMeta) {
      bulletin = await fetchDocument(bulletinMeta, adapter);
      console.log("\nRAWDOCUMENT:");
      console.log(summarizeRawDocument(bulletin));
    }

    // 5. Parsing stage (separate from discovery/retrieval): parse the
    //    already-retrieved bytes — no refetch.
    let bulletinUrl = null;
    let aboutSection = "";

    if (bulletin && bulletin.type === "PDF" && Buffer.isBuffer(bulletin.content)) {
      bulletinUrl = bulletin.url;

      const pdfText = await parsePDFBuffer(bulletin.content);
      const cleanedPDFText = cleanPDFText(pdfText, adapter.cleanPatterns);

      const sectionRule = (adapter.sections || [])[0];
      if (sectionRule) {
        aboutSection = extractSection(
          cleanedPDFText,
          sectionRule.start,
          sectionRule.end
        );
      }

      console.log("\nABOUT JEE MAIN:");
      console.log(aboutSection);

      console.log("\nPDF TEXT:");
      console.log(pdfText.slice(0, 12000));
    }

    const exam = basicInfo(data, adapter);
    console.log("\nBASIC INFO:");
    console.log(exam);

    // 6. Draft validation only — nothing is persisted anywhere.
    const examCheck = validateExam({
      slug: adapter.slug,
      name: exam.examName || adapter.name,
      fullForm: adapter.fullForm,
      conductingBody: adapter.conductingBody,
      officialWebsite: adapter.officialWebsite,
      careerType: null,
      examType: null,
    });
    console.log(
      "\nEXAM VALIDATION:",
      examCheck.success
        ? "OK"
        : JSON.stringify(examCheck.error.issues, null, 2)
    );

    const editionCheck = validateExamEdition({
      examSlug: adapter.slug,
      // Placeholder cycle label so the schema can be exercised; real
      // dates/eligibility come from the extraction phase, not invented here.
      year: 2026,
      cycle: "2026",
      registration: { startDate: null, endDate: null },
      eligibility: buildUnknownEligibility(),
      sources: bulletinUrl
        ? [
            {
              sourceUrl: adapter.officialWebsite,
              documentUrl: bulletinUrl,
              docType: "PDF",
              retrievedAt: new Date(),
              section: (adapter.sections || [])[0]
                ? (adapter.sections || [])[0].key
                : null,
              excerpt: aboutSection ? aboutSection.slice(0, 500) : null,
              confidence: "MEDIUM",
              extractor: "index.v1",
            },
          ]
        : [],
      status: "DRAFT",
    });
    console.log(
      "EXAM EDITION VALIDATION:",
      editionCheck.success
        ? "OK"
        : JSON.stringify(editionCheck.error.issues, null, 2)
    );
  } catch (error) {
    console.error("Scraping failed:", error.message);
  }
}

scrape();
