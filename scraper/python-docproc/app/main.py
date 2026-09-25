"""HTTP boundary for the document-processing specialist.

Endpoints:
  GET  /health   -> { status, service, version, backend }
  POST /process  -> multipart { file, content_type, filename?, source_url? }
                    200 + ProcessResponse, or a JSON error envelope:
                    422 unsupported content type / unreadable document,
                    400 empty upload.

The service is stateless: no MongoDB, no scraper models, no exam config, no
crawling. Run locally: `uvicorn app.main:app --host 127.0.0.1 --port 8001`
from the scraper/python-docproc directory.
"""

from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

from .processor import SERVICE_VERSION, SUPPORTED_CONTENT_TYPES, ProcessorError, get_processor
from .schemas import ErrorResponse, ProcessorInfo

app = FastAPI(title="nextstep-docproc", version=SERVICE_VERSION)
_processor = get_processor()


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "python-docproc",
        "version": SERVICE_VERSION,
        "backend": _processor.backend,
    }


@app.post("/process", responses={422: {"model": ErrorResponse}})
async def process_document(
    file: UploadFile = File(...),
    content_type: str = Form(...),
    filename: Optional[str] = Form(None),
    source_url: Optional[str] = Form(None),
):
    normalized = (content_type or "").split(";")[0].strip().lower()
    if normalized not in SUPPORTED_CONTENT_TYPES:
        return JSONResponse(
            status_code=422,
            content=ErrorResponse(
                error={
                    "type": "unsupported-content-type",
                    "detail": f"content type {content_type!r} is not supported",
                    "extra": {"filename": filename, "source_url": source_url},
                }
            ).model_dump(),
        )
    data = await file.read()
    try:
        result = _processor.process(data, normalized)
    except ProcessorError as exc:
        return JSONResponse(
            status_code=422,
            content=ErrorResponse(
                error={
                    "type": exc.error_type,
                    "detail": exc.detail,
                    "extra": {"filename": filename, "source_url": source_url},
                }
            ).model_dump(),
        )
    return JSONResponse(status_code=200, content=result.model_dump())


@app.get("/processor")
def processor_info() -> dict:
    return ProcessorInfo(
        name=_processor.name, version=SERVICE_VERSION, backend=_processor.backend
    ).model_dump()
