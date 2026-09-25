# Local LLM Semantic Proposer (STEP 7)

Disabled-by-default, local-only fallback for genuinely ambiguous spans the
deterministic layers report as `UNKNOWN` or conflicting.

## Precedence (non-negotiable)

```text
DETERMINISTIC VERIFIED RESULT  >  LLM PROPOSAL  >  UNKNOWN
```

A `KNOWN`/`RESOLVED` deterministic result blocks invocation entirely — the
proposer returns `{ invoked: false }` without touching any provider. A
proposal is review material: it rides `reconciliation.js` as
`origin: "LLM", authoritative: false`, excluded from unanimity and revision
decisions, and can never flip a deterministic outcome.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LLM_SEMANTIC_EXTRACTION` | `"false"` | `"true"` enables invocation (per-call `options.enabled` overrides) |
| `LLM_PROVIDER_URL` | `http://127.0.0.1:11434` | Ollama base URL (local only) |
| `LLM_MODEL` | `""` (required when invoking) | Local model name |

No cloud or paid providers exist in this layer. No new npm dependencies: the
Ollama provider uses global `fetch`. Ollama is never required — tests inject a
mock provider, and `OllamaProvider` is only constructed on explicit use.

## Proposal contract

`{ field, proposedValue, status, rationale, evidence[], model, provider,
createdAt }`, statuses `PROPOSED | REVIEW_REQUIRED | REJECTED`. Evidence is
mandatory: `{ sourceDocument, pageNumber, section, quotedText }[]`.

## Citation rule

Every `quotedText` must occur verbatim (modulo whitespace) in the supplied
document context, `sourceDocument` must match the context, and `pageNumber`
must fall inside the context page range. Anything else downgrades to
`{ status: "REVIEW_REQUIRED", proposedValue: null }`. Provider failures
(non-JSON, timeouts, HTTP errors) return structured `{ ok: false, error }`
envelopes — never throws, never invented data.

## Prompt rules (sent to every provider)

Supplied-context-only; never infer dates, requirements, or levels; never
derive levels from unrelated numbers; `null` when insufficient; exact quotes;
JSON only. See `SYSTEM_PROMPT` in `semanticProposer.js`.
