// =============================================================================
// scraper/tests/pdfCleaning.test.js
// =============================================================================
// WHAT: Phase 18 tests — adapter-driven PDF cleaning. Configured
//   cleanPatterns are compiled and applied by the generic cleaner; the
//   cleaner itself holds no exam-specific strings; the extraction pipeline
//   passes the adapter's patterns through on the real PDF path.
// WHY: Locks the audit fix — cleaning rules live in registry config, never
//   in engine code — while proving JEE output is byte-equivalent to before.
// DB: none for unit parts; one isolated runExtractionPipeline call uses
//   options.rawDocuments (no database connection at all).
// RUN: npm test (node --test)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const cleanPDFText = require("../normalizers/pdfText");
const { prepareText, runExtractionPipeline } = require("../pipeline/extractionPipeline");
const jeeAdapter = require("../registry/exams/jee-main");

// Minimal valid single-page PDF with the given text lines (uncompressed).
function buildMinimalPdf(lines) {
  const content =
    "BT /F1 24 Tf 100 700 Td " +
    lines.map((l) => `(${l}) Tj 0 -30 Td`).join(" ") +
    " ET";
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
    "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>";
  objs[4] =
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(pdf);
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf);
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

function pdfRawDoc(buffer, url = "http://127.0.0.1/bulletin.pdf") {
  return {
    label: "information-bulletin",
    url,
    sourceUrl: "http://127.0.0.1/",
    type: "PDF",
    contentType: "application/pdf",
    fetchedAt: new Date("2026-01-02T00:00:00Z"),
    status: 200,
    content: buffer,
  };
}

describe("Phase 18 — adapter-driven PDF cleaning", () => {
  it("applies configured patterns, including several at once", () => {
    const out = cleanPDFText("Hello FOO world BAR!", ["FOO", "BAR!"]);
    assert.equal(out, "Hello  world");
  });

  it("treats patterns as regex sources, applied globally", () => {
    const out = cleanPDFText("p1 -- 3 of 42 -- p2 -- 4 of 42 -- end", [
      "-- \\d+ of \\d+ --",
    ]);
    assert.equal(out, "p1  p2  end");
  });

  it("no cleanPatterns leaves text tidied but otherwise unchanged", () => {
    const text = "line one\n\n\nline two  ";
    for (const patterns of [undefined, null, []]) {
      assert.equal(cleanPDFText(text, patterns), "line one\n\nline two");
    }
  });

  it("rejects bad input loudly instead of guessing", () => {
    assert.throws(() => cleanPDFText(42, []), /text must be a string/);
    assert.throws(() => cleanPDFText("ok", "FOO"), /must be an array/);
    assert.throws(() => cleanPDFText("ok", ["([invalid"]), /invalid cleanPattern at index 0/);
  });

  it("JEE configuration produces equivalent cleaned output", () => {
    const sample =
      "Header -- 3 of 42 --\n" +
      "National Testing Agency\n" +
      "Body text here.\n\n\n" +
      "Excellence in Assessment\n" +
      "राष्ट् र ीय परीक्षा एजेंसी Information Bulletin - 2026\n" +
      "Tail.";
    const out = cleanPDFText(sample, jeeAdapter.cleanPatterns);
    assert.equal(out, "Header \n\nBody text here.\n\nTail.");
    for (const marker of [
      "-- 3 of 42 --",
      "National Testing Agency",
      "Excellence in Assessment",
      "Information Bulletin - 2026",
    ]) {
      assert.ok(!out.includes(marker), `marker remains: ${marker}`);
    }
  });

  it("cleaner holds no JEE-specific hardcoded patterns", () => {
    const code = fs.readFileSync(
      path.join(__dirname, "..", "normalizers", "pdfText.js"),
      "utf8"
    );
    for (const literal of [
      "National Testing Agency",
      "Excellence in Assessment",
      "राष्ट्",
      "Information Bulletin",
    ]) {
      assert.ok(!code.includes(literal), `hardcoded: ${literal}`);
    }
    assert.ok(/cleanPatterns/.test(code), "must read adapter patterns");
  });

  it("prepareText cleans real PDF bytes with the adapter patterns", async () => {
    const buffer = buildMinimalPdf([
      "Hello REGISTRATION Test MARKER-XYZ",
      "Second line here",
    ]);
    const cleaned = await prepareText(pdfRawDoc(buffer), {}, {
      cleanPatterns: ["MARKER-XYZ"],
    });
    assert.ok(!cleaned.includes("MARKER-XYZ"));
    assert.ok(cleaned.includes("Hello REGISTRATION Test"));

    const untouched = await prepareText(pdfRawDoc(buffer), {}, {});
    assert.ok(untouched.includes("MARKER-XYZ"));
  });

  it("runExtractionPipeline passes adapter cleanPatterns end to end", async () => {
    const buffer = buildMinimalPdf(["Hello REGISTRATION Test MARKER-XYZ"]);
    const adapter = {
      slug: "phase18-test-exam",
      name: "Phase18 Test Exam",
      fullForm: "Phase Eighteen Test Examination",
      conductingBody: "Phase Eighteen Test Board",
      officialWebsite: "http://127.0.0.1/",
      startUrls: ["http://127.0.0.1/"],
      render: "static",
      cleanPatterns: ["MARKER-XYZ"],
    };
    const result = await runExtractionPipeline(adapter, {
      rawDocuments: [pdfRawDoc(buffer)],
      year: 2026,
      cycle: "2026",
    });
    assert.ok(result.validation.editionOk);
    assert.ok(!result.documents[0].excerpt.includes("MARKER-XYZ"));
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
