"""Response/request contract for the document-processing specialist.

The contract is generic on purpose: pages, blocks, tables, warnings, and
processor metadata. It carries NO exam fields (no names, dates, eligibility,
subjects) — those belong to later Node extraction stages, which must reject
any payload containing them.
"""

from typing import Any, Optional

from pydantic import BaseModel, Field


class TextBlock(BaseModel):
    blockType: str = "text"
    text: str
    order: int


class TableData(BaseModel):
    rows: list[list[str]] = Field(default_factory=list)


class PageData(BaseModel):
    pageNumber: int  # 1-based, matches the PDF page order
    blocks: list[TextBlock] = Field(default_factory=list)
    tables: list[TableData] = Field(default_factory=list)


class DocumentMetadata(BaseModel):
    title: Optional[str] = None
    author: Optional[str] = None
    producer: Optional[str] = None


class ProcessorInfo(BaseModel):
    name: str
    version: str
    backend: str


class ProcessResponse(BaseModel):
    documentType: str
    pageCount: int
    pages: list[PageData] = Field(default_factory=list)
    metadata: DocumentMetadata = Field(default_factory=DocumentMetadata)
    warnings: list[str] = Field(default_factory=list)
    processor: ProcessorInfo


class ErrorDetail(BaseModel):
    type: str
    detail: str
    extra: Optional[dict[str, Any]] = None


class ErrorResponse(BaseModel):
    error: ErrorDetail


# Keys that must never appear in a processing response. The Node layer
# re-checks this; the service guarantees it by construction (it never emits
# them), and the test suite asserts both sides.
FORBIDDEN_EXAM_KEYS = frozenset(
    {
        "examName",
        "registrationStart",
        "registrationEnd",
        "eligibility",
        "subjects",
        "educationLevel",
    }
)
