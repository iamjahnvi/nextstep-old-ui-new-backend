"""Processor boundary: raw document bytes in, structured representation out.

One interface, swappable backends. The Node pipeline pins the contract in
app/schemas.py — replacing the backend (pypdf today, Docling later) must not
change what Node receives.

Backends:
  pypdf     (active)  — light, pure-Python text extraction. No table support;
                        records that honestly as a warning instead of guessing.
  docling   (dormant) — DoclingProcessor activates only when `docling` imports
                        cleanly (see README for why it is dormant here). When
                        active it fills blocks with layout order and real
                        tables through the same contract.
"""

from io import BytesIO

import pypdf

from .schemas import (
    DocumentMetadata,
    PageData,
    ProcessResponse,
    ProcessorInfo,
    TableData,
    TextBlock,
)

SERVICE_VERSION = "0.1.0"
SUPPORTED_CONTENT_TYPES = frozenset({"application/pdf"})


class ProcessorError(Exception):
    """Structured, catchable processing failure (never raw tracebacks)."""

    def __init__(self, error_type: str, detail: str):
        super().__init__(detail)
        self.error_type = error_type
        self.detail = detail


class BaseProcessor:
    name = "base"
    backend = "base"

    def process(self, data: bytes, content_type: str) -> ProcessResponse:
        raise NotImplementedError


class PypdfProcessor(BaseProcessor):
    """Born-digital PDF text extraction via pypdf (no layout, no tables)."""

    name = "python-docproc"
    backend = "pypdf"

    def process(self, data: bytes, content_type: str) -> ProcessResponse:
        if not data:
            raise ProcessorError("empty-document", "document bytes are empty")
        try:
            reader = pypdf.PdfReader(BytesIO(data))
        except Exception as exc:  # pypdf raises PdfReadError and friends
            raise ProcessorError("invalid-pdf", f"unreadable PDF: {exc}") from exc

        pages: list[PageData] = []
        for index, page in enumerate(reader.pages):
            try:
                text = page.extract_text() or ""
            except Exception:
                # Keep the page slot (order preserved) with empty text; the
                # doc-level empty-page warning below records the gap.
                text = ""
            pages.append(
                PageData(
                    pageNumber=index + 1,
                    blocks=[TextBlock(blockType="text", text=text, order=0)],
                    tables=[],
                )
            )

        info = reader.metadata or {}
        warnings = [
            "table extraction not supported by the pypdf backend; tables is always []"
        ]
        empty_pages = sum(1 for p in pages if not any(b.text.strip() for b in p.blocks))
        if empty_pages:
            warnings.append(
                f"{empty_pages} of {len(pages)} page(s) yielded no text "
                "(scanned/image content needs an OCR-capable backend)"
            )

        return ProcessResponse(
            documentType="PDF",
            pageCount=len(pages),
            pages=pages,
            metadata=DocumentMetadata(
                title=getattr(info, "title", None),
                author=getattr(info, "author", None),
                producer=getattr(info, "producer", None),
            ),
            warnings=warnings,
            processor=ProcessorInfo(
                name=self.name, version=SERVICE_VERSION, backend=self.backend
            ),
        )


class DoclingProcessor(BaseProcessor):
    """Layout-aware backend. Dormant unless `docling` is installed."""

    name = "python-docproc"
    backend = "docling"

    def __init__(self):
        try:
            from docling.document_converter import DocumentConverter  # type: ignore
        except Exception as exc:
            raise ProcessorError(
                "backend-unavailable",
                "docling is not installed; install it (see README) to enable "
                "the layout-aware backend",
            ) from exc
        self._converter = DocumentConverter()

    def process(self, data: bytes, content_type: str) -> ProcessResponse:
        if not data:
            raise ProcessorError("empty-document", "document bytes are empty")
        try:
            result = self._converter.convert(source=BytesIO(data))
        except Exception as exc:
            raise ProcessorError("invalid-pdf", f"docling could not convert the PDF: {exc}") from exc
        doc = result.document
        pages: dict[int, PageData] = {}
        order = 0
        for item in getattr(doc, "texts", []) or []:
            page_no = 1
            try:
                prov = getattr(item, "prov", None)
                if prov:
                    page_no = int(prov[0].page_no)
            except Exception:
                page_no = 1
            page = pages.setdefault(
                page_no, PageData(pageNumber=page_no, blocks=[], tables=[])
            )
            page.blocks.append(TextBlock(blockType="text", text=item.text or "", order=order))
            order += 1
        for table in getattr(doc, "tables", []) or []:
            page_no = 1
            try:
                prov = getattr(table, "prov", None)
                if prov:
                    page_no = int(prov[0].page_no)
            except Exception:
                page_no = 1
            rows: list[list[str]] = []
            try:
                grid = table.data.grid if getattr(table, "data", None) else []
                for row in grid or []:
                    rows.append([getattr(cell, "text", "") or "" for cell in row])
            except Exception:
                rows = []
            page = pages.setdefault(
                page_no, PageData(pageNumber=page_no, blocks=[], tables=[])
            )
            page.tables.append(TableData(rows=rows))
        ordered = [pages[key] for key in sorted(pages)]
        return ProcessResponse(
            documentType="PDF",
            pageCount=len(ordered),
            pages=ordered,
            metadata=DocumentMetadata(),
            warnings=[],
            processor=ProcessorInfo(
                name=self.name, version=SERVICE_VERSION, backend=self.backend
            ),
        )


def get_processor(prefer: str = "docling") -> BaseProcessor:
    """Return the best available backend (Docling when installed, else pypdf)."""
    if prefer == "docling":
        try:
            return DoclingProcessor()
        except ProcessorError:
            pass
    return PypdfProcessor()
