"""STEP 5 tests: contract, pages/order/tables, failures, backend metadata.

Fixtures are built in-test (a minimal valid 2-page PDF with computed xref),
so the suite needs no network, no models, and no exam data.
"""

from fastapi.testclient import TestClient

from app.main import app
from app.processor import get_processor
from app.schemas import FORBIDDEN_EXAM_KEYS

client = TestClient(app)


def make_pdf(page_texts):
    """Assemble a minimal valid PDF (computed xref, deterministic)."""
    out = [b"%PDF-1.4\n"]
    offsets = {}

    def obj(num, body):
        offsets[num] = sum(len(x) for x in out)
        out.append(f"{num} 0 obj\n".encode() + body + b"\nendobj\n")

    n = len(page_texts)
    page_nums = list(range(3, 3 + n))
    content_nums = list(range(3 + n, 3 + 2 * n))
    font_num = 3 + 2 * n
    obj(1, b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{p} 0 R" for p in page_nums)
    obj(2, f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode())
    for page_no, content_no in zip(page_nums, content_nums):
        obj(
            page_no,
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
            f"/Contents {content_no} 0 R "
            f"/Resources << /Font << /F1 {font_num} 0 R >> >> >>".encode(),
        )
    for content_no, text in zip(content_nums, page_texts):
        stream = f"BT /F1 12 Tf 50 250 Td ({text}) Tj ET".encode()
        obj(
            content_no,
            f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream",
        )
    obj(font_num, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    xref_pos = sum(len(x) for x in out)
    total = font_num + 1
    out.append(f"xref\n0 {total}\n".encode())
    out.append(b"0000000000 65535 f \n")
    for i in range(1, total):
        out.append(f"{offsets[i]:010d} 00000 n \n".encode())
    out.append(
        f"trailer\n<< /Size {total} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF".encode()
    )
    return b"".join(out)


def post_pdf(data, content_type="application/pdf", filename="doc.pdf"):
    return client.post(
        "/process",
        files={"file": (filename, data, content_type)},
        data={"content_type": content_type, "filename": filename},
    )


def find_keys(node, seen=None):
    seen = seen if seen is not None else set()
    if isinstance(node, dict):
        for key, value in node.items():
            seen.add(key)
            find_keys(value, seen)
    elif isinstance(node, list):
        for value in node:
            find_keys(value, seen)
    return seen


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == "python-docproc"
    assert body["backend"] in ("pypdf", "docling")


def test_pdf_accepted_with_structured_pages():
    res = post_pdf(make_pdf(["Alpha Beta", "Gamma Delta"]))
    assert res.status_code == 200
    body = res.json()
    assert body["documentType"] == "PDF"
    assert body["pageCount"] == 2
    assert [p["pageNumber"] for p in body["pages"]] == [1, 2]
    assert "Alpha Beta" in body["pages"][0]["blocks"][0]["text"]
    assert "Gamma Delta" in body["pages"][1]["blocks"][0]["text"]


def test_reading_order_preserved():
    res = post_pdf(make_pdf(["First Page Words", "Second Page Words"]))
    body = res.json()
    assert body["pages"][0]["blocks"][0]["order"] == 0
    text = " ".join(b["text"] for p in body["pages"] for b in p["blocks"])
    assert text.index("First Page Words") < text.index("Second Page Words")


def test_tables_shape_and_warnings_preserved():
    res = post_pdf(make_pdf(["Hello"]))
    body = res.json()
    for page in body["pages"]:
        assert isinstance(page["tables"], list)
    assert isinstance(body["warnings"], list) and body["warnings"]
    assert body["processor"]["name"] == "python-docproc"
    assert body["processor"]["backend"] in ("pypdf", "docling")
    assert body["processor"]["version"]


def test_no_exam_fields_anywhere():
    res = post_pdf(make_pdf(["Registration starts January", "Eligibility applies"]))
    keys = find_keys(res.json())
    assert not (keys & set(FORBIDDEN_EXAM_KEYS)), keys & set(FORBIDDEN_EXAM_KEYS)


def test_garbage_pdf_rejected():
    res = post_pdf(b"this is not a pdf at all", filename="bad.pdf")
    assert res.status_code == 422
    assert res.json()["error"]["type"] == "invalid-pdf"


def test_unsupported_content_type_rejected():
    res = client.post(
        "/process",
        files={"file": ("page.html", b"<html></html>", "text/html")},
        data={"content_type": "text/html"},
    )
    assert res.status_code == 422
    assert res.json()["error"]["type"] == "unsupported-content-type"


def test_empty_document_rejected():
    res = post_pdf(b"", filename="empty.pdf")
    assert res.status_code == 422
    assert res.json()["error"]["type"] == "empty-document"


def test_missing_file_rejected():
    res = client.post("/process", data={"content_type": "application/pdf"})
    assert res.status_code == 422


def test_processor_falls_back_without_docling():
    try:
        import docling  # noqa: F401
        assert get_processor().backend == "docling"
    except ImportError:
        assert get_processor().backend == "pypdf"
