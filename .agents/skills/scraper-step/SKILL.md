# NextStep Scraper Step Implementation

Use this skill when implementing or modifying a numbered scraper step.

## Workflow

1. Read the current step requirements and inspect only the relevant existing files.
2. Identify existing utilities, models, pipelines, tests, and conventions that should be reused.
3. Implement only the requested step.
4. Keep changes minimal and localized.
5. Run targeted tests for the changed functionality first.
6. Do not run the full test suite unless explicitly requested or necessary.
7. Do not refactor unrelated code.
8. Do not modify unrelated files.
9. Do not add new architecture when existing architecture already supports the requirement.
10. Preserve these project invariants:
   - no location functionality
   - no automatic publishing
   - no automatic acceptance
   - no automatic exam-data updates
   - missing evidence remains UNKNOWN
   - deterministic extraction remains authoritative
   - LLM proposals remain non-authoritative

## Completion report

Report:
- files changed
- functionality implemented
- targeted tests run
- results
- remaining limitations
- unrelated changes, if any