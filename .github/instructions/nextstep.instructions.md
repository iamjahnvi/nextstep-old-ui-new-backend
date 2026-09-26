---
description: Core development rules for the NextStep project
applyTo: "**/*"
---

# NextStep Development Rules

## Project
- NextStep is an exam-discovery platform for Indian students, not jobs/internships.
- Backend: Node.js + Express + MongoDB.
- Frontend: React + Vite.
- Scraper: Node.js by default; Python only when specialist tooling provides a clear technical advantage.

## Data correctness
- Deterministic extraction is authoritative.
- LLM/Ollama output is non-authoritative and must never override deterministic evidence.
- Never guess missing eligibility, dates, exam types, or career types.
- Insufficient evidence must remain `UNKNOWN`.
- `careerType` and `examType` remain `null` unless explicitly changed later.
- No location functionality.

## Safety / publishing
- `auto-publish = false`.
- `auto-acceptance = false`.
- Automatic exam-data updates = false.
- Never publish or modify production data unless explicitly requested.

## Development workflow
- Preserve the existing architecture.
- Inspect relevant existing files before creating new ones.
- Reuse existing utilities, models, pipelines, and conventions.
- Make the smallest change that satisfies the requested task.
- Do not refactor unrelated code.
- Do not modify unrelated files.
- Do not create duplicate implementations of existing functionality.

## Testing
- Run targeted tests first.
- Run the full test suite only when explicitly requested or genuinely necessary.
- Do not repeatedly rerun large test suites after every small change.
- Do not spend time investigating unrelated pre-existing failures unless they block the requested task.

## Completion
At the end of each task, report:
1. Files changed
2. Tests run
3. Test results
4. Any remaining issues
5. Any unrelated changes that were detected