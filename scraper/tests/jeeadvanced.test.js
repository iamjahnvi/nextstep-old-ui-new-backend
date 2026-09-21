// =============================================================================
// scraper/tests/jeeadvanced.test.js
// =============================================================================
// WHAT: Phase 27 proof — the third exam (JEE Advanced 2026) runs through the
//   generic pipeline driven by its registry config. No live network: a local
//   server reproduces the official site's STRUCTURE (generic "Link" anchors
//   addressable only by URL, bulletin-like eligibility prose, revised dates)
//   with synthetic content.
// WHY: Proves onboarding is config-driven a third time, on a source whose
//   anchors carry no usable text: URL-substring discovery (matchUrl), the
//   marks-anchored percentage rule (reservation figures stay UNKNOWN), DOB
//   age handling, and revised-date preference all compose with zero
//   exam-specific code.
// DB: isolated mongodb-memory-server only; MONGO_URI unset during the suite.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const mongoose = require("mongoose");
const path = require("path");

const jeeadvancedAdapter = require("../registry/exams/jee-advanced");
const { SourceAdapterConfigSchema, DocRuleSchema } = require("../registry/schema");
const { discoverDocuments } = require("../discovery/sourceDiscovery");
const { extractEligibility } = require("../extractors/eligibility");
const { runIngestionPipeline } = require("../pipeline/ingestionPipeline");
const { runExtractionPipeline } = require("../pipeline/extractionPipeline");
const { validateExamEdition } = require("../validators/examValidator");
const { getExamEditionDraftModel } = require("../models/examEditionDraft");
const {
  saveDraft,
  reviewDraft,
  promoteDraft,
  adjudicateDraft,
} = require("../pipeline/reviewPipeline");
const {
  startIsolatedDb,
  connectRawDocuments,
  closeIsolatedDb,
} = require("./helpers/isolatedDb");

const CTX = {
  sourceUrl: "http://127.0.0.1/",
  documentUrl: "http://127.0.0.1/bulletin-page.html",
  docType: "HTML",
  retrievedAt: new Date("2026-01-02T00:00:00Z"),
  section: "information-bulletin",
};

const BULLETIN_HTML =
  "<html><head><title>JEE Advanced Bulletin</title></head><body>" +
  "<h1>Information Brochure</h1>" +
  "<p>Candidates should have been born on or after October 1, 2001.</p>" +
  "<p>Must have passed class 12 Board examination with a minimum of five subjects.</p>" +
  "<p>Persons with Disability with at least 40% impairment get seat reservations.</p>" +
  "<p>Registration start date: 10 January 2026. Revised schedule: registration begins 25 January 2026.</p>" +
  "<p>The Last date of application is 20 February 2026.</p>" +
  "</body></html>";

describe("Phase 27 — JEE Advanced through the generic pipeline", () => {
  let mongod;
  let mongoUri;
  let connection;
  let EditionDraft;
  let server;
  let baseUrl;
  let savedMongoUri;

  function adapter() {
    return {
      ...jeeadvancedAdapter,
      officialWebsite: `${baseUrl}/`,
      startUrls: [`${baseUrl}/`],
      // Test-only docRule target: the real rule addresses the live bulletin
      // PDF by its URL stem ("IBEnglish"); the local fixture mirrors the
      // generic-anchor structure with a synthetic stem and HTML type.
      docRules: [
        {
          label: "information-bulletin",
          match: ["information bulletin"],
          matchUrl: ["bulletin-page"],
          type: "HTML",
        },
      ],
    };
  }

  before(async () => {
    savedMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    ({ mongod, mongoUri } = await startIsolatedDb("phase27_jeeadv"));
    ({ connection } = await connectRawDocuments(mongoUri));
    EditionDraft = getExamEditionDraftModel(connection);

    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      if (req.url === "/bulletin-page.html") {
        res.end(BULLETIN_HTML);
      } else {
        res.end(
          "<html><head><title>JEE Advanced</title></head><body>" +
            '<a href="/documents/keys.pdf">Link</a>' +
            '<a href="/bulletin-page.html">Link</a>' +
            '<a href="/other.html">Other info</a>' +
            "</body></html>"
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeIsolatedDb({ mongod, connection });
    if (savedMongoUri !== undefined) process.env.MONGO_URI = savedMongoUri;
    const open = mongoose.connections.filter((c) => c.readyState === 1);
    assert.equal(open.length, 0, "pipelines must not leak connections");
  });

  it("registry config is valid, static, URL-addressed, classification-free", () => {
    const parsed = SourceAdapterConfigSchema.safeParse(jeeadvancedAdapter);
    assert.equal(parsed.success, true);
    assert.equal(jeeadvancedAdapter.render, "static");
    assert.equal(jeeadvancedAdapter.slug, "jee-advanced");
    assert.ok(!("careerType" in jeeadvancedAdapter));
    assert.ok(!("examType" in jeeadvancedAdapter));
    assert.ok(!("month" in jeeadvancedAdapter));
    assert.deepEqual(
      jeeadvancedAdapter.docRules.map((r) => r.label),
      ["information-bulletin"]
    );
    assert.ok(
      jeeadvancedAdapter.docRules[0].matchUrl.length > 0,
      "bulletin must be URL-addressable"
    );
  });

  it("schema accepts matchUrl-only rules and rejects empty rules", () => {
    assert.equal(
      SourceAdapterConfigSchema.safeParse(
        adapter()
      ).success,
      true
    );
    const noSignals = {
      label: "x",
      match: [],
      matchUrl: [],
    };
    assert.equal(DocRuleSchema.safeParse(noSignals).success, false);
    const urlOnly = {
      label: "x",
      match: [],
      matchUrl: ["bulletin"],
    };
    assert.equal(DocRuleSchema.safeParse(urlOnly).success, true);
  });

  it("discovery resolves generic anchors by URL, text matching unchanged", () => {
    const links = [
      { text: "Link", url: "/documents/keys.pdf" },
      { text: "Link", url: "/bulletin-page.html" },
      { text: "Information Bulletin 2026", url: "/other-bulletin.html" },
    ];
    const byUrl = discoverDocuments(
      links,
      [{ label: "b", match: [], matchUrl: ["bulletin-page"] }],
      `${baseUrl}/`
    );
    assert.equal(byUrl.length, 1);
    assert.equal(byUrl[0].url, `${baseUrl}/bulletin-page.html`);

    // Relative hrefs resolve before URL matching.
    const rel = discoverDocuments(
      [{ text: "see", url: "docs/IBEnglish_2026.pdf" }],
      [{ label: "b", match: [], matchUrl: ["ibenglish"] }],
      "https://jeeadv.ac.in/"
    );
    assert.equal(rel[0].url, "https://jeeadv.ac.in/docs/IBEnglish_2026.pdf");

    // Text-only rules behave exactly as before.
    const byText = discoverDocuments(
      links,
      [{ label: "b", match: ["information bulletin"] }],
      `${baseUrl}/`
    );
    assert.equal(byText.length, 1);
    assert.equal(byText[0].url, `${baseUrl}/other-bulletin.html`);
  });

  it("reservation percentages stay UNKNOWN without marks anchoring", () => {
    const eligibility = extractEligibility(
      "Persons with Disability with at least 40% impairment get seat reservations.",
      CTX,
      { subjectVocabulary: [], streamVocabulary: [] }
    );
    assert.equal(eligibility.percentage.status, "UNKNOWN");
    assert.equal(eligibility.percentage.min, null);

    const marks = extractEligibility(
      "Candidates must have secured at least 75% aggregate marks.",
      CTX,
      { subjectVocabulary: [], streamVocabulary: [] }
    );
    assert.equal(marks.percentage.status, "KNOWN");
    assert.equal(marks.percentage.min, 75);
  });

  it("ingests the URL-addressed bulletin despite decoy generic links", async () => {
    const ingestion = await runIngestionPipeline(adapter(), { mongoUri });
    assert.equal(ingestion.adapter, "jee-advanced");
    assert.equal(ingestion.strategy, "static");
    assert.equal(ingestion.discovered, 1);
    assert.equal(ingestion.stored, 1);
    assert.ok(ingestion.results[0].url.endsWith("/bulletin-page.html"));
    assert.ok(
      ingestion.pageUrl.startsWith("http://127.0.0.1"),
      "no live dependency"
    );

    const { connection: c2, RawDocument } = await connectRawDocuments(mongoUri);
    try {
      assert.equal(await RawDocument.countDocuments({}), 1);
    } finally {
      await c2.close();
    }
  });

  it("extracts a valid DRAFT with honest UNKNOWNs and revised dates", async () => {
    const extraction = await runExtractionPipeline(adapter(), {
      mongoUri,
      year: 2026,
      cycle: "2026",
    });
    assert.ok(validateExamEdition(extraction.edition).success);

    // Revised start preferred; explicit end kept.
    assert.equal(
      extraction.edition.registration.startDate.toISOString(),
      "2026-01-25T00:00:00.000Z"
    );
    assert.equal(
      extraction.edition.registration.endDate.toISOString(),
      "2026-02-20T00:00:00.000Z"
    );

    // Class XII known; reservation figure not mistaken for marks.
    assert.equal(extraction.edition.eligibility.education.status, "KNOWN");
    assert.equal(extraction.edition.eligibility.education.minLevel, "12");
    assert.equal(extraction.edition.eligibility.percentage.status, "UNKNOWN");
    assert.equal(extraction.edition.eligibility.percentage.min, null);

    // DOB cutoff is informative but not an integer age.
    assert.equal(extraction.edition.eligibility.age.status, "NEEDS_VERIFICATION");

    // Streams/subjects stay UNKNOWN on empty vocabularies.
    assert.equal(extraction.edition.eligibility.stream.status, "UNKNOWN");
    assert.equal(extraction.edition.eligibility.subjects.status, "UNKNOWN");

    // Evidence is attached and points at the staged sources.
    assert.ok(extraction.edition.sources.length > 0);
    for (const source of extraction.edition.sources) {
      assert.ok(source.documentUrl.startsWith("http://127.0.0.1"));
    }

    // Contract holds for the third exam too.
    assert.equal(extraction.exam.careerType, null);
    assert.equal(extraction.exam.examType, null);
    assert.ok(!("month" in extraction.edition));
    assert.equal(extraction.edition.status, "DRAFT");
    assert.equal(extraction.exam.conductingBody, "Indian Institute of Technology Roorkee");
  });

  it("review lifecycle reaches VERIFIED with honest adjudication", async () => {
    const extraction = await runExtractionPipeline(adapter(), {
      mongoUri,
      year: 2026,
      cycle: "2026",
    });
    const staged = await saveDraft(EditionDraft, {
      exam: extraction.exam,
      edition: extraction.edition,
    });
    assert.equal(staged.status, "DRAFT");
    assert.equal(reviewDraft(staged).valid, true);

    // Percentage has no evidence-backed value: reviewed and kept UNKNOWN.
    const kept = await adjudicateDraft(EditionDraft, staged._id, {
      axis: "percentage",
      decision: "KEEP_UNKNOWN",
      decidedBy: "phase27-operator",
      note: "No marks-based criterion in source",
    });
    assert.equal(kept.edition.eligibility.percentage.status, "UNKNOWN");

    const verified = await promoteDraft(EditionDraft, staged._id);
    assert.equal(verified.status, "VERIFIED");
    assert.equal(verified.adjudications.length, 1);
  });

  it("leaves no temporary/download artifacts in the repo", () => {
    const repoRoot = path.join(__dirname, "..");
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          entry.name.endsWith(".tmp") ||
          /^(download|temp).*\.pdf$/i.test(entry.name)
        ) {
          offenders.push(full);
        }
      }
    };
    walk(repoRoot);
    assert.deepEqual(offenders, []);
  });
});
