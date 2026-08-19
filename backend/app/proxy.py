"""Brand-aware streaming passthrough to the Zoho Integration Service."""

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .auth import get_session
from .config import get_settings

router = APIRouter(prefix="/api", dependencies=[Depends(get_session)])

# Headers copied back from the service on streamed responses
_PASS_RESPONSE_HEADERS = {"content-type", "content-length", "content-disposition"}

_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=600.0))
    return _client


def _service_headers(brand: str) -> dict:
    settings = get_settings()
    if brand not in {b.code for b in settings.brands}:
        raise HTTPException(status_code=404, detail=f"Unknown brand: {brand}")
    return {"X-Brand": brand, "X-Internal-Token": settings.internal_token}


def _service_url(path: str) -> str:
    return f"{get_settings().service_url}{path}"


@router.get("/me")
async def me(session: dict = Depends(get_session)):
    return {"email": session.get("email"), "name": session.get("name")}


@router.get("/brands")
async def brands():
    return [b.model_dump() for b in get_settings().brands]


async def _forward_json(
    method: str, brand: str, path: str, *, params: dict | None = None, json_body=None
):
    client = get_client()
    try:
        resp = await client.request(
            method,
            _service_url(path),
            params=params,
            json=json_body,
            headers=_service_headers(brand),
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Storage service unreachable: {exc}")
    content_type = resp.headers.get("content-type", "")
    body = resp.json() if content_type.startswith("application/json") else {"detail": resp.text}
    return JSONResponse(status_code=resp.status_code, content=body)


@router.get("/{brand}/teamfolders")
async def teamfolders(brand: str):
    return await _forward_json("GET", brand, "/zoho/workdrive/teamfolders")


@router.get("/{brand}/folders/{folder_id}/children")
async def children(brand: str, folder_id: str, request: Request):
    return await _forward_json(
        "GET",
        brand,
        f"/zoho/workdrive/folders/{folder_id}/children",
        params=dict(request.query_params),
    )


@router.get("/{brand}/search")
async def search(brand: str, request: Request):
    return await _forward_json(
        "GET", brand, "/zoho/workdrive/search", params=dict(request.query_params)
    )


@router.post("/{brand}/folders")
async def create_folder(brand: str, body: dict):
    return await _forward_json("POST", brand, "/zoho/workdrive/folders", json_body=body)


@router.patch("/{brand}/files/{file_id}")
async def update_file(brand: str, file_id: str, body: dict):
    return await _forward_json(
        "PATCH", brand, f"/zoho/workdrive/files/{file_id}", json_body=body
    )


@router.delete("/{brand}/files/{file_id}")
async def delete_file(brand: str, file_id: str):
    return await _forward_json("DELETE", brand, f"/zoho/workdrive/files/{file_id}")


@router.get("/{brand}/files/{file_id}/download")
async def download(brand: str, file_id: str):
    client = get_client()
    req = client.build_request(
        "GET",
        _service_url(f"/zoho/workdrive/files/{file_id}/download"),
        headers=_service_headers(brand),
    )
    try:
        resp = await client.send(req, stream=True)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Storage service unreachable: {exc}")
    if resp.status_code >= 400:
        detail = (await resp.aread()).decode(errors="replace")
        await resp.aclose()
        return JSONResponse(status_code=resp.status_code, content={"detail": detail})
    headers = {
        k: v for k, v in resp.headers.items() if k.lower() in _PASS_RESPONSE_HEADERS
    }
    return StreamingResponse(
        resp.aiter_bytes(),
        status_code=resp.status_code,
        headers=headers,
        background=None,
    )


@router.post("/{brand}/folders/{folder_id}/upload")
async def upload(brand: str, folder_id: str, request: Request):
    """Forward the multipart body verbatim as a stream — no buffering."""
    client = get_client()
    headers = _service_headers(brand)
    for h in ("content-type", "content-length"):
        if h in request.headers:
            headers[h] = request.headers[h]
    try:
        resp = await client.request(
            "POST",
            _service_url(f"/zoho/workdrive/folders/{folder_id}/upload"),
            content=request.stream(),
            headers=headers,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Storage service unreachable: {exc}")
    content_type = resp.headers.get("content-type", "")
    body = resp.json() if content_type.startswith("application/json") else {"detail": resp.text}
    return JSONResponse(status_code=resp.status_code, content=body)
