// =============================================================================
// scraper/tests/documentProcessing.test.js
// =============================================================================
// WHAT: STEP 5 tests — thin Node layer over the Python document specialist.
//   Covers invocation rules (PDF+profile gating, HTML stays on Node),
//   representation validation (pages/order/tables/metadata/warnings, exam-key
//   rejection), and isolated failure envelopes (timeout/refused/5xx/422/
//   malformed). The Python service itself is stubbed by contract shape — the
//   real service has its own pytest suite (scraper/python-docproc/tests).
// WHY: Python must run only for profile-flagged PDFs, and its failures must
//   arrive as structured, retryability-marked errors — never crashes, never
//   invented data.
// DB: none — local stub HTTP servers only.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");

const {
  shouldUsePython,
  validateRepresentation,
  processWithPython,
  processDocument,
} = require("../pipeline/documentProcessing");

const PDF_BYTES = Buffer.from("%PDF-1.4\n%stub\n", "latin1");

function pdfDoc(url = "http://127.0.0.1/doc.pdf") {
  return { label: "doc", url, sourceUrl: "http://127.0.0.1/", type: "PDF", fetchedAt: new Date(), status: 200, contentType: "application/pdf", content: PDF_BYTES };
}

function htmlDoc() {
  return { label: "page", url: "http://127.0.0.1/page.html", sourceUrl: "http://127.0.0.1/", type: "HTML", fetchedAt: new Date(), status: 200, contentType: null, content: "<html></html>" };
}

function validRep() {
  return {
    documentType: "PDF",
    pageCount: 2,
    pages: [
      { pageNumber: 1, blocks: [{ blockType: "text", text: "Alpha", order: 0 }], tables: [] },
      { pageNumber: 2, blocks: [{ blockType: "text", text: "Beta", order: 0 }], tables: [{ rows: [["a", "b"]] }] },
    ],
    metadata: { title: null, author: null, producer: null },
    warnings: ["table extraction not supported by the pypdf backend; tables is always []"],
    processor: { name: "python-docproc", version: "0.1.0", backend: "pypdf" },
  };
}

function stubService(handler) {
  const state = { hits: 0 };
  const server = http.createServer((req, res) => {
    state.hits += 1;
    handler(req, res, state);
  });
  return {
    state,
    listen: () => new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

describe("STEP 5 — invocation rule", () => {
  it("1. ordinary HTML never routes to Python", () => {
    for (const profile of [undefined, null, { type: "STATIC_HTML" }, { type: "PDF" }]) {
      const decision = shouldUsePython(htmlDoc(), profile);
      assert.equal(decision.usePython, false);
    }
  });

  it("2. profile decides for PDFs: PDF/MIXED invoke, others stay", () => {
    assert.equal(shouldUsePython(pdfDoc(), undefined).usePython, true);
    assert.equal(shouldUsePython(pdfDoc(), { type: "PDF" }).usePython, true);
    assert.equal(shouldUsePython(pdfDoc(), { type: "MIXED" }).usePython, true);
    assert.equal(shouldUsePython(pdfDoc(), { type: "STATIC_HTML" }).usePython, false);
    assert.equal(shouldUsePython(pdfDoc(), { type: "JAVASCRIPT_HTML" }).usePython, false);
    assert.equal(shouldUsePython(pdfDoc(), { type: "UNKNOWN" }).usePython, false);
  });

  it("3. processDocument short-circuits HTML without touching the service", async () => {
    const svc = stubService((req, res) => json(res, 200, validRep()));
    const base = await svc.listen();
    try {
      const out = await processDocument(htmlDoc(), { serviceUrl: base });
      assert.equal(out.ok, true);
      assert.equal(out.handled, false);
      assert.equal(out.path, "node");
      assert.equal(svc.state.hits, 0);
    } finally {
      await svc.close();
    }
  });
});

describe("STEP 5 — representation contract", () => {
  it("4. valid representation passes with pages, order, tables, metadata", () => {
    const check = validateRepresentation(validRep());
    assert.equal(check.valid, true);
    assert.deepEqual(check.issues, []);
  });

  it("5. page order and shape violations fail loudly", () => {
    const swapped = validRep();
    swapped.pages = [swapped.pages[1], swapped.pages[0]];
    assert.equal(validateRepresentation(swapped).valid, false);
    const noPages = validRep();
    delete noPages.pages;
    assert.equal(validateRepresentation(noPages).valid, false);
    assert.equal(validateRepresentation(null).valid, false);
    assert.equal(validateRepresentation("text").valid, false);
  });

  it("6. exam fields are rejected structurally", () => {
    const tainted = validRep();
    tainted.pages[0].blocks[0].eligibility = { status: "KNOWN" };
    const check = validateRepresentation(tainted);
    assert.equal(check.valid, false);
    assert.ok(check.issues.some((issue) => issue.includes("eligibility")));
  });

  it("7. PDF input reaches the service and metadata/warnings survive", async () => {
    const svc = stubService((req, res) => json(res, 200, validRep()));
    const base = await svc.listen();
    try {
      const out = await processWithPython(pdfDoc(), { serviceUrl: base });
      assert.equal(out.ok, true);
      assert.equal(out.representation.pageCount, 2);
      assert.deepEqual(out.representation.pages.map((p) => p.pageNumber), [1, 2]);
      assert.deepEqual(out.representation.warnings, validRep().warnings);
      assert.equal(out.representation.processor.backend, "pypdf");
      assert.equal(svc.state.hits, 1);
    } finally {
      await svc.close();
    }
  });

  it("8. non-Buffer PDF content is rejected without calling the service", async () => {
    const svc = stubService((req, res) => json(res, 200, validRep()));
    const base = await svc.listen();
    try {
      const doc = pdfDoc();
      doc.content = "%PDF-1.4 not-a-buffer";
      const out = await processWithPython(doc, { serviceUrl: base });
      assert.equal(out.ok, false);
      assert.equal(out.error.type, "invalid-input");
      assert.equal(out.error.retryable, false);
      assert.equal(out.error.processor, "python-docproc");
      assert.equal(svc.state.hits, 0);
    } finally {
      await svc.close();
    }
  });
});

describe("STEP 5 — isolated failures", () => {
  it("9. processor 422 becomes a non-retryable typed error", async () => {
    const svc = stubService((req, res) =>
      json(res, 422, { error: { type: "invalid-pdf", detail: "unreadable PDF: EOF" } })
    );
    const base = await svc.listen();
    try {
      const out = await processWithPython(pdfDoc(), { serviceUrl: base });
      assert.equal(out.ok, false);
      assert.equal(out.error.type, "processor-invalid-pdf");
      assert.equal(out.error.retryable, false);
      assert.equal(out.error.url, "http://127.0.0.1/doc.pdf");
      assert.ok(out.error.timestamp);
    } finally {
      await svc.close();
    }
  });

  it("10. service 500 is retryable; malformed success bodies are not", async () => {
    const failing = stubService((req, res) => json(res, 500, { error: "boom" }));
    const base = await failing.listen();
    try {
      const out = await processWithPython(pdfDoc(), { serviceUrl: base });
      assert.equal(out.ok, false);
      assert.equal(out.error.type, "http-error");
      assert.equal(out.error.retryable, true);
    } finally {
      await failing.close();
    }
    const malformed = stubService((req, res) => json(res, 200, { documentType: "PDF" }));
    const base2 = await malformed.listen();
    try {
      const out = await processWithPython(pdfDoc(), { serviceUrl: base2 });
      assert.equal(out.ok, false);
      assert.equal(out.error.type, "invalid-response");
      assert.equal(out.error.retryable, false);
    } finally {
      await malformed.close();
    }
  });

  it("11. timeouts and refused connections are retryable and never throw", async () => {
    const slow = stubService((req, res) => setTimeout(() => json(res, 200, validRep()), 1500));
    const base = await slow.listen();
    try {
      const out = await processWithPython(pdfDoc(), { serviceUrl: base, timeoutMs: 300 });
      assert.equal(out.ok, false);
      assert.equal(out.error.type, "timeout");
      assert.equal(out.error.retryable, true);
    } finally {
      await slow.close();
    }
    const refused = await processWithPython(pdfDoc(), { serviceUrl: "http://127.0.0.1:1", timeoutMs: 5000 });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.type, "connection-error");
    assert.equal(refused.error.retryable, true);
  });

  it("12. Node layer carries no exam logic and never invents data", () => {
    const code = fs.readFileSync(path.join(__dirname, "..", "pipeline", "documentProcessing.js"), "utf8");
    // Strip string literals FIRST, then comments: URLs like "http://..."
    // contain "//" which would otherwise desync comment stripping. The
    // forbidden-key denylist is data (needed to reject tainted payloads),
    // not logic — identifiers must not name exam fields.
    const executable = code
      .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
      .replace(/\/\/.*$/gm, "");
    assert.ok(
      !/eligibility|registrationStart|educationLevel|examName|subjects/i.test(executable),
      "integration layer must not name exam fields"
    );
  });
});
