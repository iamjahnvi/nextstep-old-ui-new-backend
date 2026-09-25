# python-docproc — stateless document-processing specialist (STEP 5)

Receives raw document bytes, returns a **generic structured representation**
(pages, text blocks, tables, warnings, processor metadata). It knows nothing
about exams and emits no exam fields — later Node extraction stages own those.

## Contract

`POST /process` (multipart): `file` (bytes) + `content_type` + optional
`filename`, `source_url`. Minimum supported input: `application/pdf`.

`200` → `{ documentType, pageCount, pages[{ pageNumber (1-based), blocks[{ blockType, text, order }], tables[{ rows }]}],
metadata{title,author,producer}, warnings[], processor{name,version,backend} }`.

`422` → `{ error: { type, detail, extra? } }` for `unsupported-content-type`,
`empty-document`, `invalid-pdf`. No MongoDB, no scraper models, no crawling.

## Backend choice (evaluated, documented)

| Candidate | Verdict |
|---|---|
| **pypdf** (active) | Solves born-digital text extraction. Free (BSD), pure-Python, 395 kB, local. No table/layout support — recorded as a warning, never guessed. |
| **Docling** (dormant) | Would add layout order + real tables, but needs torch plus multi-hundred-MB model downloads and has no clean support for this environment (Python 3.14). `DoclingProcessor` in `app/processor.py` activates automatically if `docling` ever imports — zero contract change, zero Node change. Deliberately one PDF library, not five. |
| OCR engines | Not added: unjustified until a scanned-PDF workload is benchmarked (a later step). |

## Run / test

```text
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8001   # from this directory
python -m pytest tests -q
```

The Node layer (`scraper/pipeline/documentProcessing.js`) calls this service
only for profile-flagged PDFs (`PYTHON_DOCPROC_URL` overrides the default
`http://127.0.0.1:8001`); everything else stays on the Node path, and every
failure arrives back as a structured, retryability-marked error envelope.
