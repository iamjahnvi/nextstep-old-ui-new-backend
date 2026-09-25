// =============================================================================
// scraper/tests/llmProposer.test.js
// =============================================================================
// WHAT: STEP 7 tests — optional local-LLM proposer gates, proposal contract,
//   citation verification, deterministic precedence, reconciliation riding,
//   and failure isolation. A mock local provider stands in for Ollama: no
//   model, server, or network is ever required.
// WHY: The proposer must be provably inert by default and provably
//   non-authoritative when enabled — suggestions with mappable evidence only.
// DB: none — pure functions and an in-memory mock provider.
// RUN: npm test (node --test)
// =============================================================================

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { PROPOSAL_STATUSES, validateProposal } = require("../extractors/llm/schemas");
const {
  FEATURE_FLAG,
  isEnabled,
  verifyCitations,
  OllamaProvider,
  proposeField,
} = require("../extractors/llm/semanticProposer");
const { reconcileField } = require("../extractors/reconciliation");

const CONTEXT = {
  text: "ELIGIBILITY\nCandidates must have passed Class XII from a recognized board. Applications open in January.",
  sourceDocument: "http://127.0.0.1/bulletin.html",
  pageCount: 3,
};

function mockProvider(text, extra = {}) {
  return {
    name: "mock-local",
    model: "mock-model",
    calls: 0,
    async complete() {
      this.calls += 1;
      return { text, model: "mock-model", ...extra };
    },
  };
}

function goodProposalJson() {
  return JSON.stringify({
    proposedValue: "12",
    status: "PROPOSED",
    rationale: "The eligibility section states Class XII explicitly.",
    evidence: [
      {
        sourceDocument: "http://127.0.0.1/bulletin.html",
        pageNumber: 1,
        section: "ELIGIBILITY",
        quotedText: "Candidates must have passed Class XII from a recognized board.",
      },
    ],
  });
}

describe("STEP 7 — gates and precedence", () => {
  let saved;
  beforeEach(() => {
    saved = process.env[FEATURE_FLAG];
    delete process.env[FEATURE_FLAG];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[FEATURE_FLAG];
    else process.env[FEATURE_FLAG] = saved;
  });

  it("1. feature is disabled by default", () => {
    assert.equal(FEATURE_FLAG, "LLM_SEMANTIC_EXTRACTION");
    assert.equal(isEnabled({}), false);
    assert.equal(isEnabled({ enabled: false }), false);
    assert.equal(isEnabled({ enabled: true }), true);
    process.env[FEATURE_FLAG] = "true";
    assert.equal(isEnabled({}), true);
  });

  it("2. disabled mode makes zero provider calls", async () => {
    const provider = mockProvider(goodProposalJson());
    const out = await proposeField({
      field: "education",
      ambiguousSpan: "Class XII",
      documentContext: CONTEXT,
      deterministic: { status: "UNKNOWN", value: null },
      provider,
      options: { enabled: false },
    });
    assert.equal(out.invoked, false);
    assert.equal(provider.calls, 0);
  });

  it("3. ambiguous input invokes the provider when explicitly enabled", async () => {
    const provider = mockProvider(goodProposalJson());
    const out = await proposeField({
      field: "education",
      ambiguousSpan: "Class XII or equivalent",
      documentContext: CONTEXT,
      deterministic: { status: "UNKNOWN", value: null },
      provider,
      options: { enabled: true },
    });
    assert.equal(out.invoked, true);
    assert.equal(out.ok, true);
    assert.equal(provider.calls, 1);
    assert.equal(out.proposal.field, "education");
    assert.equal(out.proposal.proposedValue, "12");
    assert.equal(out.proposal.status, "PROPOSED");
    assert.equal(out.proposal.provider, "mock-local");
    assert.ok(out.proposal.createdAt);
  });

  it("4. deterministic KNOWN/RESOLVED results block invocation", async () => {
    for (const deterministic of [
      { status: "KNOWN", value: "12" },
      { status: "RESOLVED", value: "2026-01-10T00:00:00.000Z" },
    ]) {
      const provider = mockProvider(goodProposalJson());
      const out = await proposeField({
        field: "education",
        ambiguousSpan: "anything",
        documentContext: CONTEXT,
        deterministic,
        provider,
        options: { enabled: true },
      });
      assert.equal(out.invoked, false, JSON.stringify(deterministic));
      assert.match(out.reason, /authoritative/);
      assert.equal(provider.calls, 0);
    }
  });
});

describe("STEP 7 — proposal contract and citations", () => {
  it("5. proposal schema accepts complete proposals, rejects bare values", () => {
    assert.deepEqual(PROPOSAL_STATUSES, ["PROPOSED", "REVIEW_REQUIRED", "REJECTED"]);
    const good = validateProposal({
      field: "education",
      proposedValue: "12",
      status: "PROPOSED",
      rationale: "stated explicitly",
      evidence: [
        { sourceDocument: "http://127.0.0.1/b.html", pageNumber: 2, section: "ELIGIBILITY", quotedText: "Class XII" },
      ],
      model: "m",
      provider: "p",
    });
    assert.equal(good.valid, true);
    assert.equal(good.proposal.evidence[0].pageNumber, 2);

    for (const bad of [
      { field: "education", proposedValue: "12" },
      { field: "education", proposedValue: "12", status: "PROPOSED", rationale: "r", evidence: [], model: "m", provider: "p" },
      { field: "education", proposedValue: "12", status: "MAYBE", rationale: "r", evidence: [{ sourceDocument: "u", pageNumber: 1, section: null, quotedText: "q" }], model: "m", provider: "p" },
      { field: "education", proposedValue: "12", status: "PROPOSED", rationale: "r", evidence: [{ sourceDocument: "u", pageNumber: 1, section: null, quotedText: "  " }], model: "m", provider: "p" },
    ]) {
      assert.equal(validateProposal(bad).valid, false);
    }
  });

  it("6. missing evidence is rejected", async () => {
    const provider = mockProvider(
      JSON.stringify({ proposedValue: "12", status: "PROPOSED", rationale: "trust me", evidence: [] })
    );
    const out = await proposeField({
      field: "education",
      ambiguousSpan: "Class XII",
      documentContext: CONTEXT,
      deterministic: { status: "UNKNOWN", value: null },
      provider,
      options: { enabled: true },
    });
    assert.equal(out.invoked, true);
    assert.equal(out.ok, true);
    assert.equal(out.proposal.status, "REVIEW_REQUIRED");
    assert.equal(out.proposal.proposedValue, null);
  });

  it("7. fabricated citations become REVIEW_REQUIRED with null value", async () => {
    const provider = mockProvider(
      JSON.stringify({
        proposedValue: "Graduate",
        status: "PROPOSED",
        rationale: "invented reading",
        evidence: [
          { sourceDocument: "http://127.0.0.1/bulletin.html", pageNumber: 1, section: "ELIGIBILITY", quotedText: "Candidates must hold a doctoral fellowship." },
        ],
      })
    );
    const out = await proposeField({
      field: "education",
      ambiguousSpan: "fellowship",
      documentContext: CONTEXT,
      deterministic: { status: "UNKNOWN", value: null },
      provider,
      options: { enabled: true },
    });
    assert.equal(out.proposal.status, "REVIEW_REQUIRED");
    assert.equal(out.proposal.proposedValue, null);
    assert.match(out.proposal.rationale, /citation verification failed/);
  });

  it("8. quoted text must exist verbatim in the supplied context", () => {
    const proposal = {
      evidence: [
        { sourceDocument: CONTEXT.sourceDocument, pageNumber: 1, section: "ELIGIBILITY", quotedText: "Candidates must have passed Class XII from a recognized board." },
      ],
    };
    assert.deepEqual(verifyCitations(proposal, CONTEXT), []);
    const wrongDoc = {
      evidence: [
        { sourceDocument: "http://127.0.0.1/other.html", pageNumber: 1, section: null, quotedText: "Candidates must have passed Class XII from a recognized board." },
      ],
    };
    assert.ok(verifyCitations(wrongDoc, CONTEXT).some((issue) => issue.includes("sourceDocument")));
    const outOfRange = {
      evidence: [
        { sourceDocument: CONTEXT.sourceDocument, pageNumber: 9, section: null, quotedText: "Applications open in January." },
      ],
    };
    assert.ok(verifyCitations(outOfRange, CONTEXT).some((issue) => issue.includes("page range")));
  });
});

describe("STEP 7 — reconciliation riding and failures", () => {
  it("9. LLM proposals ride along but never resolve or overwrite", () => {
    const det = {
      value: "2026-01-10T00:00:00.000Z",
      evidence: { excerpt: "10 Jan" },
      docLabel: "bulletin",
      documentUrl: "http://127.0.0.1/a.html",
      fetchedAt: new Date("2026-01-02T00:00:00Z"),
    };
    const llm = {
      value: "2026-01-15T00:00:00.000Z",
      evidence: { excerpt: "model guess" },
      docLabel: "llm",
      documentUrl: null,
      origin: "LLM",
      authoritative: false,
      proposal: { field: "registrationEnd", status: "PROPOSED" },
    };
    const out = reconcileField({ field: "registrationEnd", candidates: [det, llm] });
    assert.equal(out.status, "RESOLVED");
    assert.equal(out.selectedValue, "2026-01-10T00:00:00.000Z");
    assert.equal(out.evidence.length, 1);
    assert.equal(out.llmProposals.length, 1);
    assert.equal(out.llmProposals[0].authoritative, false);

    // An LLM-only field stays unresolved: proposals suggest, never decide.
    const alone = reconcileField({ field: "education", candidates: [llm] });
    assert.equal(alone.status, "INSUFFICIENT_EVIDENCE");
    assert.equal(alone.selectedValue, null);
    assert.equal(alone.llmProposals.length, 1);
  });

  it("10. LLM conflict input stays a deterministic conflict", () => {
    const a = { value: "X", evidence: { e: 1 }, docLabel: "a", documentUrl: "http://127.0.0.1/a.html" };
    const b = { value: "Y", evidence: { e: 2 }, docLabel: "b", documentUrl: "http://127.0.0.1/b.html" };
    const llm = { value: "Y", evidence: null, origin: "LLM", authoritative: false, proposal: { field: "f", status: "PROPOSED" } };
    const out = reconcileField({ field: "f", candidates: [a, b, llm] });
    assert.equal(out.status, "CONFLICT");
    assert.equal(out.selectedValue, null);
  });

  it("11. provider failures are structured and retryability-marked", async () => {
    const failing = { name: "mock-local", async complete() { throw new Error("connection refused"); } };
    const out = await proposeField({
      field: "education",
      ambiguousSpan: "x",
      documentContext: CONTEXT,
      deterministic: null,
      provider: failing,
      options: { enabled: true },
    });
    assert.equal(out.invoked, true);
    assert.equal(out.ok, false);
    assert.equal(out.error.type, "provider-error");
    assert.equal(typeof out.error.retryable, "boolean");

    const nonJson = mockProvider("not json at all {{{");
    const out2 = await proposeField({
      field: "education",
      ambiguousSpan: "x",
      documentContext: CONTEXT,
      deterministic: null,
      provider: nonJson,
      options: { enabled: true },
    });
    assert.equal(out2.proposal.status, "REVIEW_REQUIRED");
    assert.equal(out2.proposal.proposedValue, null);
  });

  it("12. no provider configured is a safe structured miss", async () => {
    const out = await proposeField({
      field: "education",
      ambiguousSpan: "x",
      documentContext: CONTEXT,
      deterministic: { status: "CONFLICT", value: null },
      provider: null,
      options: { enabled: true },
    });
    assert.equal(out.invoked, true);
    assert.equal(out.ok, false);
    assert.equal(out.error.type, "no-provider");
    assert.equal(out.error.retryable, false);
  });

  it("13. layer is local-only, generic, and dependency-free", () => {
    for (const relative of ["extractors/llm/schemas.js", "extractors/llm/semanticProposer.js"]) {
      const code = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
      assert.ok(!/openai|anthropic|claude|gpt-|gemini|azure|api[_-]?key/i.test(code), `${relative}: no cloud providers or keys`);
      assert.ok(!/require\(["'](axios|mongoose|crawlee|playwright)["']\)/.test(code), `${relative}: no heavy deps`);
      const executable = code
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "")
        .replace(/\/\/.*$/gm, "");
      assert.ok(!/\bjee\b|\bgate\b|\bneet\b|\bupsc\b|\bnta\b|\biit\b/i.test(executable), `${relative}: no exam names`);
    }
    // Ollama provider exists but is never required: construction is lazy and
    // completion needs an explicit model + reachable local server.
    const provider = new OllamaProvider({ baseUrl: "http://127.0.0.1:9", model: "" });
    assert.equal(provider.name, "ollama");
    assert.equal(provider.baseUrl, "http://127.0.0.1:9");
  });
});
