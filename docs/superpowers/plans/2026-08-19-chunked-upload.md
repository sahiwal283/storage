# Chunked WorkDrive Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Large files (≥ 10 MiB) upload in 8 MiB chunks through storage → Zoho Integration Service → WorkDrive, with same-tab pause/resume and a serial queue; small files stay on multipart; if chunk Start is unavailable, files ≤ 2 GiB fall back to WorkDrive’s stream API.

**Architecture:** Browser never talks to Zoho. Storage never talks to Zoho. New Start / Chunk / Finish routes on the Zoho service reuse capability `workdrive.upload`. Chunks are raw `Content-Range` bodies streamed to `POST {upload_base_url}/stream/upload` with a stable `upload-id`. One-shot large POSTs to the existing `/upload` route also use stream (Approach 1 fallback and leftover clients). In-memory session table on the Zoho service process (lost on restart; close-tab already abandons).

**Tech Stack:** FastAPI + httpx (both apps), React + TypeScript + Vite (storage UI), pytest / pytest-asyncio (Zoho + storage backend), Vitest (storage upload orchestration). Two git repos.

**Spec:** `docs/superpowers/specs/2026-08-19-chunked-upload-design.md`

## Global Constraints

- Cutoffs (verbatim): simple multipart if `size < 10 MiB` (`10 * 1024 * 1024`); chunk payload `8 MiB` (`8 * 1024 * 1024`); stream fallback max `2 GiB` (`2048 * 1024 * 1024`); WorkDrive plan limit is the hard ceiling.
- Storage never calls Zoho; browser never calls Zoho; OAuth stays on LXC 9503.
- Zoho 401 from upstream → **502**. Missing `storage_session` → **401**. Chunk/Start 401 must **not** set `window.location` to `/auth/login` (only `/api/me` and `/api/brands` do that).
- Do not use Starlette `UploadFile` on chunk PUT (no whole-file spool). Do not assemble the file on either LXC.
- Reuse capability slug `workdrive.upload` for Start/Chunk/Finish. Do **not** add new capability slugs or re-run the grant script unless Start fails for missing capability (403).
- Error envelope for unavailable chunk API must match existing `_err()`: HTTP **503**, `detail.error.code == "CHUNK_UPLOAD_UNAVAILABLE"` (not a new `{detail: {code}}` shape).
- Name-clash policy unchanged (`override_name_exist` default `false`).
- Queue is serial. Pause is same-tab only. No resume-after-refresh. No parallel uploads. No browser→Zoho.
- Versions: Zoho Integration Service **1.38.0** (MINOR); Storage **1.2.0** (MINOR) in the same change as that repo’s code. Spec-only commit already landed; do not bump versions in a docs-only follow-up.
- Never print secrets (`INTERNAL_TOKEN`, OAuth, session cookie).
- No live upload to production as a test.

## File Structure

| File | Repo | Responsibility |
|------|------|----------------|
| `app/clients/workdrive_client.py` | zoho-integration-service | `SIMPLE_UPLOAD_MAX_BYTES`, `CHUNK_SIZE_BYTES`, `ChunkUploadUnavailableError`, `upload_file_stream`, size-based `upload_file`, `start_chunked_upload`, `upload_chunk`, `complete_chunked_upload` |
| `app/clients/workdrive_chunk_sessions.py` | zoho-integration-service | In-memory `{upload_id: ChunkSession}` + `reset_for_testing()` |
| `app/api/workdrive.py` | zoho-integration-service | Start / Chunk / Finish routes; existing upload uses stream when size ≥ 10 MiB |
| `tests/test_workdrive.py` | zoho-integration-service | Client + route tests (mocked httpx / client) |
| `tests/conftest.py` | zoho-integration-service | Call `reset_for_testing()` so sessions do not leak |
| `VERSION`, `docs/VERSIONING.md`, `API_ROUTES.md` | zoho-integration-service | 1.38.0 |
| `backend/app/proxy.py` | storage | Proxy Start / Chunk / Finish; chunk PUT streams like today’s upload |
| `backend/tests/test_app.py` | storage | Proxy mapping + 401→502 + cookie 401 |
| `frontend/src/upload/constants.ts` | storage | Shared cutoffs |
| `frontend/src/upload/chunkedUpload.ts` | storage | Start→chunks→Finish, retries, fallback, 401 handling |
| `frontend/src/upload/queue.ts` | storage | Serial job queue |
| `frontend/src/upload/*.test.ts` | storage | Vitest |
| `frontend/src/api.ts` | storage | `startUpload`, `putChunk`, `completeUpload`; error code helper |
| `frontend/src/App.tsx` | storage | Queue, keep-alive, `beforeunload` |
| `frontend/src/components/UploadTray.tsx` | storage | Pause / Resume / Retry / fallback note |
| `frontend/src/styles.css` | storage | Tray action buttons |
| `VERSION`, `frontend/package.json`, `docs/VERSIONING.md` | storage | 1.2.0 |
| `frontend/package.json`, `frontend/vite.config.ts` | storage | Add `vitest` script |

Repos on disk:

- Zoho: `/Users/sahilkhatri/Work/services/zoho-integration-service`
- Storage: `/Users/sahilkhatri/Work/storage`

Zoho pytest env (prefix every Zoho pytest command):

```bash
cd /Users/sahilkhatri/Work/services/zoho-integration-service
DATABASE_URL="sqlite+aiosqlite:///:memory:" \
INTERNAL_API_TOKEN="test-token-12345" \
ENCRYPTION_KEY="YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY=" \
ADMIN_API_TOKEN="test-admin-token-12345" \
pytest tests/test_workdrive.py -v --tb=short
```

Storage pytest:

```bash
cd /Users/sahilkhatri/Work/storage/backend && pytest tests/test_app.py -v --tb=short
```

---

### Task 1: Stream one-shot upload on the WorkDrive client

**Files:**
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/app/clients/workdrive_client.py`
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/tests/test_workdrive.py` (`TestWorkDriveClientUnit`)

**Interfaces:**
- Consumes: existing `WorkDriveClient._auth_headers`, `_stream_timeout`, `_raise_for_error`, `_data_item`, `upload_base_url`, `api_base_url`
- Produces:
  - `SIMPLE_UPLOAD_MAX_BYTES: int = 10 * 1024 * 1024`
  - `CHUNK_SIZE_BYTES: int = 8 * 1024 * 1024`
  - `STREAM_FALLBACK_MAX_BYTES: int = 2048 * 1024 * 1024`
  - `class ChunkUploadUnavailableError(WorkDriveError)` — used in later tasks; define it here so imports stay stable
  - `async def upload_file_stream(self, *, parent_id: str, filename: str, fileobj: BinaryIO, size: int, content_type: str | None = None, override_name_exist: bool = False, upload_id: str | None = None) -> dict[str, Any]`
  - `upload_file(...)` gains optional `size: int | None = None`. If `size is None`, measure via seek/tell when possible. If `size >= SIMPLE_UPLOAD_MAX_BYTES`, call `upload_file_stream`; else keep today’s multipart POST to `{api_base_url}/upload`

- [ ] **Step 1: Write the failing tests**

Add to `TestWorkDriveClientUnit` in `tests/test_workdrive.py` (keep the existing FakeClient pattern; this FakeClient must accept `content=`):

```python
@pytest.mark.asyncio
async def test_upload_file_stream_posts_to_stream_host(self):
    captured: dict = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers=None, content=None, params=None, files=None):
            captured["url"] = url
            captured["headers"] = headers
            captured["content"] = content
            captured["files"] = files
            return Response(
                200,
                json={
                    "data": {
                        "id": "att-1",
                        "type": "attachments",
                        "attributes": {"resource_id": "f1", "FileName": "big.bin"},
                    }
                },
            )

    client = WorkDriveClient(
        db=None, credential_id=1, region="us", extra_config={"team_id": "tm-1"}
    )
    with (
        patch.object(
            WorkDriveClient,
            "_auth_headers",
            new=AsyncMock(
                return_value={
                    "Authorization": "Zoho-oauthtoken t",
                    "Accept": "application/vnd.api+json",
                }
            ),
        ),
        patch("app.clients.workdrive_client.httpx.AsyncClient", FakeClient),
    ):
        result = await client.upload_file_stream(
            parent_id="fld-1",
            filename="big.bin",
            fileobj=BytesIO(b"hello-stream"),
            size=12,
            content_type="application/octet-stream",
            upload_id="uid-1",
        )
    assert captured["url"] == "https://upload.zoho.com/workdrive-api/v1/stream/upload"
    assert captured["files"] is None
    assert captured["headers"]["x-parent_id"] == "fld-1"
    assert captured["headers"]["x-streammode"] == "1"
    assert captured["headers"]["upload-id"] == "uid-1"
    assert captured["headers"]["x-filename"]  # URL-encoded name
    assert result["id"] == "att-1"


@pytest.mark.asyncio
async def test_upload_file_uses_stream_when_size_at_cutoff(self):
    captured: dict = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers=None, content=None, params=None, files=None):
            captured["url"] = url
            return Response(
                200,
                json={"data": {"id": "att-1", "type": "attachments", "attributes": {}}},
            )

    client = WorkDriveClient(
        db=None, credential_id=1, region="us", extra_config={"team_id": "tm-1"}
    )
    blob = BytesIO(b"x" * (10 * 1024 * 1024))
    with (
        patch.object(
            WorkDriveClient,
            "_auth_headers",
            new=AsyncMock(
                return_value={"Authorization": "Zoho-oauthtoken t", "Accept": "application/vnd.api+json"}
            ),
        ),
        patch("app.clients.workdrive_client.httpx.AsyncClient", FakeClient),
    ):
        await client.upload_file(
            parent_id="fld-1",
            filename="a.bin",
            fileobj=blob,
            content_type="application/octet-stream",
            size=10 * 1024 * 1024,
        )
    assert captured["url"] == "https://upload.zoho.com/workdrive-api/v1/stream/upload"
```

Keep `test_upload_file_posts_to_api_host` asserting `{api_base}/upload` for the small `BytesIO(b"hi")` case (no `size=` or `size=2`).

- [ ] **Step 2: Run tests to verify they fail**

Run the Zoho pytest command with `tests/test_workdrive.py::TestWorkDriveClientUnit -v --tb=short`

Expected: FAIL with `upload_file_stream` not defined.

- [ ] **Step 3: Write minimal implementation**

In `workdrive_client.py` (top-level, after `_STREAM_CHUNK_SIZE`):

```python
SIMPLE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024
CHUNK_SIZE_BYTES = 8 * 1024 * 1024
STREAM_FALLBACK_MAX_BYTES = 2048 * 1024 * 1024


class ChunkUploadUnavailableError(WorkDriveError):
    """WorkDrive has no chunk/stream session API for this credential/host."""
```

Add `upload_file_stream`: POST `{self.upload_base_url}/stream/upload` with headers `Authorization`, `x-filename` (`urllib.parse.quote(filename)`), `x-parent_id`, `x-streammode: 1`, `upload-id` (argument or `uuid.uuid4()`), `x-override-name-exist` `"true"`/`"false"`, `Content-Type: application/octet-stream`, `Content-Length: str(size)`. Body = `fileobj` (httpx reads it). Single-shot; do not retry. Then `_raise_for_error` + `_data_item`.

In `upload_file`, if `size is None` try:

```python
pos = fileobj.tell()
fileobj.seek(0, 2)
measured = fileobj.tell()
fileobj.seek(pos)
size = measured
```

If seek fails, treat as small (multipart). If `size >= SIMPLE_UPLOAD_MAX_BYTES`, return `await self.upload_file_stream(...)`.

Add `import uuid` and `from urllib.parse import quote` at module top (no inline imports).

- [ ] **Step 4: Run tests to verify they pass**

Same pytest selector. Expected: PASS, including existing `test_upload_file_posts_to_api_host`.

- [ ] **Step 5: Commit** (zoho-integration-service repo)

```bash
git add app/clients/workdrive_client.py tests/test_workdrive.py
git commit -m "feat: send large WorkDrive uploads to the stream API"
```

---

### Task 2: Chunk session store + Start probe

**Files:**
- Create: `/Users/sahilkhatri/Work/services/zoho-integration-service/app/clients/workdrive_chunk_sessions.py`
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/app/clients/workdrive_client.py`
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/tests/test_workdrive.py`
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/tests/conftest.py`

**Interfaces:**
- Consumes: `ChunkUploadUnavailableError`, `CHUNK_SIZE_BYTES`, `upload_base_url`, `_auth_headers`
- Produces:
  - `@dataclass ChunkSession` with fields `upload_id: str`, `parent_id: str`, `filename: str`, `size: int`, `content_type: str`, `override_name_exist: bool`, `acked_end: int` (start at `-1`), `file_item: dict[str, Any] | None`
  - `put_session(session: ChunkSession) -> None`
  - `get_session(upload_id: str) -> ChunkSession | None`
  - `pop_session(upload_id: str) -> ChunkSession | None`
  - `reset_for_testing() -> None`
  - `async def start_chunked_upload(self, *, parent_id: str, filename: str, size: int, content_type: str, override_name_exist: bool = False) -> dict[str, Any]`  
    Returns `{"upload_id": str, "chunk_size": CHUNK_SIZE_BYTES}`  
    Raises `ChunkUploadUnavailableError` when the probe is 404 or the body contains `URL_RULE_NOT_CONFIGURED`

- [ ] **Step 1: Write the failing tests**

```python
@pytest.mark.asyncio
async def test_start_chunked_upload_probes_stream_and_stores_session(self):
    from app.clients.workdrive_chunk_sessions import get_session, reset_for_testing

    reset_for_testing()
    captured: dict = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers=None, content=None, params=None, files=None):
            captured["url"] = url
            captured["headers"] = headers
            captured["content"] = content
            return Response(200, json={})

    client = WorkDriveClient(
        db=None, credential_id=1, region="us", extra_config={"team_id": "tm-1"}
    )
    with (
        patch.object(
            WorkDriveClient,
            "_auth_headers",
            new=AsyncMock(
                return_value={"Authorization": "Zoho-oauthtoken t", "Accept": "application/vnd.api+json"}
            ),
        ),
        patch("app.clients.workdrive_client.httpx.AsyncClient", FakeClient),
    ):
        out = await client.start_chunked_upload(
            parent_id="fld-1",
            filename="deck.psd",
            size=15_000_000,
            content_type="application/octet-stream",
        )
    assert out["chunk_size"] == 8 * 1024 * 1024
    assert captured["url"].endswith("/stream/upload")
    assert captured["headers"]["x-streammode"] == "1"
    assert captured["content"] == b""
    stored = get_session(out["upload_id"])
    assert stored is not None
    assert stored.parent_id == "fld-1"
    assert stored.size == 15_000_000
    assert stored.acked_end == -1


@pytest.mark.asyncio
async def test_start_chunked_upload_url_rule_is_unavailable(self):
    from app.clients.workdrive_client import ChunkUploadUnavailableError
    from app.clients.workdrive_chunk_sessions import reset_for_testing

    reset_for_testing()

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers=None, content=None, params=None, files=None):
            return Response(
                401,
                json={"errors": [{"id": "R801", "title": "URL_RULE_NOT_CONFIGURED"}]},
            )

    client = WorkDriveClient(
        db=None, credential_id=1, region="us", extra_config={"team_id": "tm-1"}
    )
    with (
        patch.object(
            WorkDriveClient,
            "_auth_headers",
            new=AsyncMock(
                return_value={"Authorization": "Zoho-oauthtoken t", "Accept": "application/vnd.api+json"}
            ),
        ),
        patch("app.clients.workdrive_client.httpx.AsyncClient", FakeClient),
    ):
        with pytest.raises(ChunkUploadUnavailableError):
            await client.start_chunked_upload(
                parent_id="fld-1",
                filename="a.bin",
                size=15_000_000,
                content_type="application/octet-stream",
            )
```

- [ ] **Step 2: Run tests to verify they fail**

`pytest tests/test_workdrive.py::TestWorkDriveClientUnit::test_start_chunked_upload_probes_stream_and_stores_session tests/test_workdrive.py::TestWorkDriveClientUnit::test_start_chunked_upload_url_rule_is_unavailable -v --tb=short` with the Zoho env prefix.

Expected: FAIL import / attribute error.

- [ ] **Step 3: Write minimal implementation**

`workdrive_chunk_sessions.py`: module-level `dict[str, ChunkSession]`, functions above, `reset_for_testing` clears the dict.

`start_chunked_upload`: generate `upload_id = str(uuid.uuid4())`. POST `{upload_base_url}/stream/upload` with `Content-Length: 0`, `content=b""`, `Content-Range: bytes */{size}`, plus the stream headers from Task 1. Helper `_chunk_api_unavailable(response: httpx.Response) -> bool`: `status_code == 404` OR `"URL_RULE_NOT_CONFIGURED"` in `response.text`. If true, raise `ChunkUploadUnavailableError`. If other ≥400, `_raise_for_error`. Then `put_session(...)`.

In `tests/conftest.py` `_isolate_test_app_state`, import and call `reset_for_testing()` from `workdrive_chunk_sessions` in both setup and teardown.

- [ ] **Step 4: Run tests to verify they pass**

Same two tests + `pytest tests/test_workdrive.py -v --tb=short` (full file) so conftest import cannot break other WorkDrive tests.

- [ ] **Step 5: Commit** (zoho-integration-service)

```bash
git add app/clients/workdrive_chunk_sessions.py app/clients/workdrive_client.py tests/test_workdrive.py tests/conftest.py
git commit -m "feat: probe WorkDrive stream API and store chunk sessions"
```

---

### Task 3: Upload chunk + complete on the client

**Files:**
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/app/clients/workdrive_client.py`
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/tests/test_workdrive.py`

**Interfaces:**
- Consumes: `get_session` / `put_session` / `pop_session`, `ChunkSession`
- Produces:
  - `async def upload_chunk(self, *, upload_id: str, start: int, end: int, body: bytes) -> dict[str, Any]`  
    Returns `{"acked_end": end}`. Raises `WorkDriveError` with `status_code=404` if session missing. Sets `session.acked_end = end`. If `end == session.size - 1` and response JSON has `data`, set `session.file_item = _data_item(payload)`.
  - `async def complete_chunked_upload(self, *, upload_id: str) -> dict[str, Any]`  
    If `session.file_item` is set, `pop_session` and return it. If `acked_end != size - 1`, raise `WorkDriveError` (`status_code=400`, message that not all bytes were acked). If acked but no `file_item`, POST empty body to stream/upload with `Content-Range: bytes {size-1}-{size-1}/{size}` (last-byte touch) or a zero-length POST with the same `upload-id`; parse `_data_item`; `pop_session`; return the item. If still empty, raise `WorkDriveError`.

`start`/`end` are inclusive byte offsets (`Content-Range: bytes {start}-{end}/{total}`).

- [ ] **Step 1: Write the failing tests**

```python
@pytest.mark.asyncio
async def test_upload_chunk_sends_content_range_and_acks(self):
    from app.clients.workdrive_chunk_sessions import (
        ChunkSession,
        get_session,
        put_session,
        reset_for_testing,
    )

    reset_for_testing()
    put_session(
        ChunkSession(
            upload_id="uid-1",
            parent_id="fld-1",
            filename="a.bin",
            size=20,
            content_type="application/octet-stream",
            override_name_exist=False,
            acked_end=-1,
            file_item=None,
        )
    )
    captured: dict = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers=None, content=None, params=None, files=None):
            captured["headers"] = headers
            captured["content"] = content
            return Response(200, json={})

    client = WorkDriveClient(
        db=None, credential_id=1, region="us", extra_config={"team_id": "tm-1"}
    )
    with (
        patch.object(
            WorkDriveClient,
            "_auth_headers",
            new=AsyncMock(
                return_value={"Authorization": "Zoho-oauthtoken t", "Accept": "application/vnd.api+json"}
            ),
        ),
        patch("app.clients.workdrive_client.httpx.AsyncClient", FakeClient),
    ):
        out = await client.upload_chunk(
            upload_id="uid-1", start=0, end=9, body=b"0123456789"
        )
    assert out == {"acked_end": 9}
    assert captured["headers"]["Content-Range"] == "bytes 0-9/20"
    assert captured["content"] == b"0123456789"
    assert get_session("uid-1").acked_end == 9


@pytest.mark.asyncio
async def test_complete_returns_file_item_from_last_chunk(self):
    from app.clients.workdrive_chunk_sessions import ChunkSession, put_session, reset_for_testing

    reset_for_testing()
    item = {"id": "att-1", "type": "attachments", "attributes": {"resource_id": "f1"}}
    put_session(
        ChunkSession(
            upload_id="uid-1",
            parent_id="fld-1",
            filename="a.bin",
            size=10,
            content_type="application/octet-stream",
            override_name_exist=False,
            acked_end=9,
            file_item=item,
        )
    )
    client = WorkDriveClient(
        db=None, credential_id=1, region="us", extra_config={"team_id": "tm-1"}
    )
    result = await client.complete_chunked_upload(upload_id="uid-1")
    assert result == item
```

Also add `test_upload_chunk_unknown_session_is_404` expecting `WorkDriveError` with `status_code == 404`.

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL `upload_chunk` not defined.

- [ ] **Step 3: Write minimal implementation**

`upload_chunk` looks up session, POSTs stream/upload with the same stream headers as Start (filename/parent/upload-id/streammode/override) plus `Content-Range` and `Content-Length: str(end - start + 1)`, `content=body`. Do not retry (caller retries). Update session. Last-chunk JSON → `file_item`.

`complete_chunked_upload` as in Interfaces.

- [ ] **Step 4: Run tests to verify they pass**

`pytest tests/test_workdrive.py::TestWorkDriveClientUnit -v --tb=short`

- [ ] **Step 5: Commit** (zoho-integration-service)

```bash
git add app/clients/workdrive_client.py tests/test_workdrive.py
git commit -m "feat: WorkDrive chunk PUT and complete against stream/upload"
```

---

### Task 4: Start / Chunk / Finish HTTP routes

**Files:**
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/app/api/workdrive.py`
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/tests/test_workdrive.py`

**Interfaces:**
- Consumes: `start_chunked_upload`, `upload_chunk`, `complete_chunked_upload`, `ChunkUploadUnavailableError`, `_prepare(..., action="upload")`, `_normalize_upload_result` / `_normalize_item`, `_map_workdrive_error`, `_err`
- Produces (capability `workdrive.upload` on all three):
  - `POST /zoho/workdrive/folders/{folder_id}/uploads` JSON `{filename, size, content_type}` → `{ok, upload_id, chunk_size, meta}`  
    Query `override_name_exist: bool = False`  
    On `ChunkUploadUnavailableError`: `_err("CHUNK_UPLOAD_UNAVAILABLE", ..., 503)`
  - `PUT /zoho/workdrive/uploads/{upload_id}/chunks` raw body, header `Content-Range: bytes start-end/total` → `{ok, acked_end, meta}`  
    Read body with `body = await request.body()` (max one chunk / 8 MiB, not a whole designer file). Do **not** declare `UploadFile`.
  - `POST /zoho/workdrive/uploads/{upload_id}/complete` → same envelope as today’s upload: `{ok, brand, item, file, meta}`

Pydantic start body: `extra=forbid`, non-blank `filename`, `size > 0`, `content_type` default `application/octet-stream`.

Content-Range parse: regex `bytes (\d+)-(\d+)/(\d+)$`. Invalid → 400 `WORKDRIVE_VALIDATION_ERROR`.

- [ ] **Step 1: Write the failing tests**

Add URL constants:

```python
START_UPLOAD_URL = "/zoho/workdrive/folders/fld-001/uploads"
CHUNK_URL = "/zoho/workdrive/uploads/uid-1/chunks"
COMPLETE_URL = "/zoho/workdrive/uploads/uid-1/complete"
```

New class `TestChunkedUpload` using `wd_db`, `wd_ctx`, `_override_auth` / `_clear_auth` like `TestUpload`:

```python
class TestChunkedUpload:
    @pytest.mark.asyncio
    async def test_start_returns_upload_id(self, wd_db, wd_ctx):
        _override_auth(wd_ctx)
        try:
            with patch.object(
                WorkDriveClient,
                "start_chunked_upload",
                new_callable=AsyncMock,
                return_value={"upload_id": "uid-1", "chunk_size": 8388608},
            ) as mock_start:
                async with _client() as client:
                    resp = await client.post(
                        START_UPLOAD_URL,
                        json={
                            "filename": "deck.psd",
                            "size": 15_000_000,
                            "content_type": "image/vnd.adobe.photoshop",
                        },
                        headers=HB,
                    )
            assert resp.status_code == 200, resp.text
            data = resp.json()
            assert data["upload_id"] == "uid-1"
            assert data["chunk_size"] == 8388608
            assert data["meta"]["capability"] == "workdrive.upload"
            assert mock_start.await_args.kwargs["parent_id"] == "fld-001"
        finally:
            _clear_auth()

    @pytest.mark.asyncio
    async def test_start_unavailable_is_503_typed(self, wd_db, wd_ctx):
        from app.clients.workdrive_client import ChunkUploadUnavailableError

        _override_auth(wd_ctx)
        try:
            with patch.object(
                WorkDriveClient,
                "start_chunked_upload",
                new_callable=AsyncMock,
                side_effect=ChunkUploadUnavailableError("no chunk api", status_code=401),
            ):
                async with _client() as client:
                    resp = await client.post(
                        START_UPLOAD_URL,
                        json={"filename": "a.bin", "size": 15_000_000, "content_type": "application/octet-stream"},
                        headers=HB,
                    )
            assert resp.status_code == 503
            assert resp.json()["detail"]["error"]["code"] == "CHUNK_UPLOAD_UNAVAILABLE"
        finally:
            _clear_auth()

    @pytest.mark.asyncio
    async def test_chunk_forwards_range_and_body(self, wd_db, wd_ctx):
        _override_auth(wd_ctx)
        try:
            with patch.object(
                WorkDriveClient,
                "upload_chunk",
                new_callable=AsyncMock,
                return_value={"acked_end": 3},
            ) as mock_chunk:
                async with _client() as client:
                    resp = await client.put(
                        CHUNK_URL,
                        content=b"abcd",
                        headers={**HB, "Content-Range": "bytes 0-3/10"},
                    )
            assert resp.status_code == 200, resp.text
            assert resp.json()["acked_end"] == 3
            assert mock_chunk.await_args.kwargs["start"] == 0
            assert mock_chunk.await_args.kwargs["end"] == 3
            assert mock_chunk.await_args.kwargs["body"] == b"abcd"
        finally:
            _clear_auth()

    @pytest.mark.asyncio
    async def test_complete_returns_normalized_item(self, wd_db, wd_ctx):
        _override_auth(wd_ctx)
        try:
            raw = {
                "id": "att-1",
                "type": "attachments",
                "attributes": {"resource_id": "file-new-1", "FileName": "a.bin"},
            }
            with patch.object(
                WorkDriveClient,
                "complete_chunked_upload",
                new_callable=AsyncMock,
                return_value=raw,
            ):
                async with _client() as client:
                    resp = await client.post(COMPLETE_URL, headers=HB)
            assert resp.status_code == 200, resp.text
            data = resp.json()
            assert data["ok"] is True
            assert data["item"]["id"] == "file-new-1"
            assert data["file"] == data["item"]
            assert data["meta"]["capability"] == "workdrive.upload"
        finally:
            _clear_auth()
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: 404 on `START_UPLOAD_URL`.

- [ ] **Step 3: Write minimal implementation**

Add routes at the bottom of `workdrive.py` (before any catch-all). Document them in the module docstring list. `action = "upload"` so `_capability` stays `workdrive.upload`. Catch `ChunkUploadUnavailableError` **before** `_map_workdrive_error` (a 401 URL rule must not become 502 `WORKDRIVE_UPSTREAM_AUTH_ERROR`).

Audit each route with `_audit` like `upload_file`.

- [ ] **Step 4: Run tests to verify they pass**

`pytest tests/test_workdrive.py::TestChunkedUpload tests/test_workdrive.py::TestUpload -v --tb=short`

- [ ] **Step 5: Commit** (zoho-integration-service)

```bash
git add app/api/workdrive.py tests/test_workdrive.py
git commit -m "feat: WorkDrive chunked upload Start/Chunk/Finish routes"
```

---

### Task 5: Existing `/upload` uses stream above 10 MiB

**Files:**
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/app/api/workdrive.py` (`upload_file` handler)
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/tests/test_workdrive.py`

**Interfaces:**
- Consumes: `upload_file(..., size=)`
- Produces: unchanged HTTP contract for `POST /zoho/workdrive/folders/{folder_id}/upload`

- [ ] **Step 1: Write the failing test**

In `TestUpload`:

```python
@pytest.mark.asyncio
async def test_upload_passes_size_to_client(self, wd_db, wd_ctx):
    _override_auth(wd_ctx)
    try:
        with patch.object(
            WorkDriveClient,
            "upload_file",
            new_callable=AsyncMock,
            return_value={
                "id": "att-1",
                "type": "attachments",
                "attributes": {"resource_id": "file-new-1", "FileName": "hello.txt"},
            },
        ) as mock_upload:
            async with _client() as client:
                resp = await client.post(
                    UPLOAD_URL,
                    files={"file": ("hello.txt", b"hello world", "text/plain")},
                    headers=HB,
                )
        assert resp.status_code == 200
        assert mock_upload.await_args.kwargs["size"] == 11
    finally:
        _clear_auth()
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL `size` missing from kwargs.

- [ ] **Step 3: Write minimal implementation**

Pass `size=file.size` into `ctx.client.upload_file` (Starlette sets `UploadFile.size` from the part). If `file.size` is `None`, omit / pass `None` and let the client measure.

- [ ] **Step 4: Run tests to verify they pass**

`pytest tests/test_workdrive.py::TestUpload -v --tb=short`

- [ ] **Step 5: Commit** (zoho-integration-service)

```bash
git add app/api/workdrive.py tests/test_workdrive.py
git commit -m "feat: pass upload size so large one-shot files use stream API"
```

---

### Task 6: Zoho service MINOR 1.38.0 + docs

**Files:**
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/VERSION` → `1.38.0`
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/docs/VERSIONING.md` history row + **Current**
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/API_ROUTES.md` Storage App bullet to mention Start/Chunk/Finish and stream fallback
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/app/api/workdrive.py` module docstring version + route list
- Modify: `/Users/sahilkhatri/Work/services/zoho-integration-service/CLAUDE.md` WorkDrive row if it lists routes

**Interfaces:** none (docs + version). Existing `tests/test_version.py` must still pass.

- [ ] **Step 1: Update VERSION and changelog**

`VERSION` contents exactly `1.38.0`. Add history row dated 2026-08-19, type minor, summary: chunked WorkDrive upload (Start/Chunk/Finish) + stream API for files ≥ 10 MiB.

- [ ] **Step 2: Run version + WorkDrive tests**

```bash
pytest tests/test_version.py tests/test_workdrive.py -v --tb=short
```

Expected: PASS, health version 1.38.0.

- [ ] **Step 3: Commit** (zoho-integration-service)

```bash
git add VERSION docs/VERSIONING.md API_ROUTES.md app/api/workdrive.py CLAUDE.md
git commit -m "chore: bump Zoho Integration Service to 1.38.0 for chunked WorkDrive upload"
```

Do not deploy from this plan unless the user asks. Storage is still on the old upload path until Tasks 7–10.

---

### Task 7: Storage proxy for Start / Chunk / Finish

**Files:**
- Modify: `/Users/sahilkhatri/Work/storage/backend/app/proxy.py`
- Modify: `/Users/sahilkhatri/Work/storage/backend/tests/test_app.py`

**Interfaces:**
- Consumes: `_service_headers`, `_service_url`, `get_client`, 401→502 rule
- Produces:
  - `POST /api/{brand}/folders/{folder_id}/uploads` → `_forward_json` to `/zoho/workdrive/folders/{folder_id}/uploads`
  - `PUT /api/{brand}/uploads/{upload_id}/chunks` → stream like `upload()`: copy `content-type`, `content-length`, `content-range`; `content=request.stream()`
  - `POST /api/{brand}/uploads/{upload_id}/complete` → `_forward_json` to `/zoho/workdrive/uploads/{upload_id}/complete`

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_app.py`, FakeClient for JSON routes already uses `request(method, url, params=None, json=None, headers=None)`. Extend **new** fakes with `content=None` so chunk tests work:

```python
@pytest.mark.anyio
async def test_start_upload_forwards_json(client, monkeypatch):
    captured = {}

    class FakeClient:
        async def request(self, method, url, params=None, json=None, headers=None, content=None):
            captured.update(method=method, url=url, json=json, headers=headers)
            return _FakeUpstream(200, {"ok": True, "upload_id": "uid-1", "chunk_size": 8388608})

    monkeypatch.setattr(proxy, "get_client", lambda: FakeClient())
    resp = await client.post(
        "/api/haute_brands/folders/fld-1/uploads",
        json={"filename": "a.bin", "size": 15_000_000, "content_type": "application/octet-stream"},
        cookies={SESSION_COOKIE: session_cookie()},
    )
    assert resp.status_code == 200
    assert captured["method"] == "POST"
    assert captured["url"].endswith("/zoho/workdrive/folders/fld-1/uploads")
    assert captured["json"]["filename"] == "a.bin"


@pytest.mark.anyio
async def test_chunk_upload_streams_and_copies_content_range(client, monkeypatch):
    captured = {}

    class FakeClient:
        async def request(self, method, url, params=None, json=None, headers=None, content=None):
            captured.update(method=method, url=url, headers=headers)
            captured["content"] = content
            return _FakeUpstream(200, {"ok": True, "acked_end": 3})

    monkeypatch.setattr(proxy, "get_client", lambda: FakeClient())
    resp = await client.put(
        "/api/haute_brands/uploads/uid-1/chunks",
        content=b"abcd",
        headers={"Content-Range": "bytes 0-3/10", "Content-Type": "application/octet-stream"},
        cookies={SESSION_COOKIE: session_cookie()},
    )
    assert resp.status_code == 200
    assert captured["method"] == "PUT"
    assert captured["url"].endswith("/zoho/workdrive/uploads/uid-1/chunks")
    assert captured["headers"]["content-range"] == "bytes 0-3/10"


@pytest.mark.anyio
async def test_chunk_upstream_401_is_502(client, monkeypatch):
    class FakeClient:
        async def request(self, method, url, params=None, json=None, headers=None, content=None):
            return _FakeUpstream(401, {"detail": {"error": {"code": "ZOHO_AUTH_INVALID"}}})

    monkeypatch.setattr(proxy, "get_client", lambda: FakeClient())
    resp = await client.put(
        "/api/haute_brands/uploads/uid-1/chunks",
        content=b"x",
        headers={"Content-Range": "bytes 0-0/1"},
        cookies={SESSION_COOKIE: session_cookie()},
    )
    assert resp.status_code == 502


@pytest.mark.anyio
async def test_chunk_without_session_is_401(client):
    resp = await client.put(
        "/api/haute_brands/uploads/uid-1/chunks",
        content=b"x",
        headers={"Content-Range": "bytes 0-0/1"},
    )
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_complete_upload_forwards_post(client, monkeypatch):
    captured = {}

    class FakeClient:
        async def request(self, method, url, params=None, json=None, headers=None, content=None):
            captured.update(method=method, url=url)
            return _FakeUpstream(200, {"ok": True, "item": {"id": "f1", "name": "a.bin"}})

    monkeypatch.setattr(proxy, "get_client", lambda: FakeClient())
    resp = await client.post(
        "/api/haute_brands/uploads/uid-1/complete",
        cookies={SESSION_COOKIE: session_cookie()},
    )
    assert resp.status_code == 200
    assert captured["url"].endswith("/zoho/workdrive/uploads/uid-1/complete")
```

Header lookup: Starlette lowercases incoming headers; when copying to the service, use the same loop as `upload()` (`for h in ("content-type", "content-length")`) plus `"content-range"`.

- [ ] **Step 2: Run tests to verify they fail**

`cd /Users/sahilkhatri/Work/storage/backend && pytest tests/test_app.py::test_start_upload_forwards_json -v --tb=short`

Expected: 404.

- [ ] **Step 3: Write minimal implementation**

JSON start/complete via `_forward_json`. Chunk PUT copy of `upload()` including 401→502. Do not parse JSON if the upstream body is empty; still use the same JSONResponse pattern as `upload()`.

- [ ] **Step 4: Run tests to verify they pass**

`pytest tests/test_app.py -v --tb=short`

- [ ] **Step 5: Commit** (storage repo)

```bash
git add backend/app/proxy.py backend/tests/test_app.py
git commit -m "feat: proxy WorkDrive chunked upload Start/Chunk/Finish"
```

---

### Task 8: Frontend chunked-upload module + Vitest

**Files:**
- Create: `/Users/sahilkhatri/Work/storage/frontend/src/upload/constants.ts`
- Create: `/Users/sahilkhatri/Work/storage/frontend/src/upload/chunkedUpload.ts`
- Create: `/Users/sahilkhatri/Work/storage/frontend/src/upload/chunkedUpload.test.ts`
- Modify: `/Users/sahilkhatri/Work/storage/frontend/src/api.ts`
- Modify: `/Users/sahilkhatri/Work/storage/frontend/package.json` (add vitest; **do not** bump `"version"` here — that is Task 10)
- Modify: `/Users/sahilkhatri/Work/storage/frontend/vite.config.ts`

**Interfaces:**
- Produces:
  - `SIMPLE_UPLOAD_MAX = 10 * 1024 * 1024`
  - `CHUNK_SIZE = 8 * 1024 * 1024`
  - `STREAM_FALLBACK_MAX = 2048 * 1024 * 1024`
  - `export type ChunkTransport` with:
    - `start(folderId, body): Promise<{ upload_id: string; chunk_size: number }>`
    - `putChunk(uploadId, blob, contentRange, onProgress, signal): Promise<{ acked_end: number }>`
    - `complete(uploadId): Promise<void>`
    - `simpleUpload(folderId, file, onProgress, signal): Promise<void>`
  - `export class SessionExpiredError extends Error`
  - `export async function uploadFile(opts: { brand: string; folderId: string; file: File; transport: ChunkTransport; onProgress: (pct: number) => void; isPaused: () => boolean; signal: AbortSignal; waitWhilePaused: () => Promise<void>; sleep?: (ms: number) => Promise<void>; }): Promise<{ mode: "chunked" | "simple" | "fallback"; uploadId?: string }>`
  - Behavior:
    - `file.size < SIMPLE_UPLOAD_MAX` → `simpleUpload` only; return `"simple"`
    - else `start`. If thrown error has `code === "CHUNK_UPLOAD_UNAVAILABLE"`:
      - if `file.size > STREAM_FALLBACK_MAX` throw `Error` with a readable over-2GiB message
      - else `simpleUpload` (which hits existing `/upload`; service streams it) and return `"fallback"`
    - else loop: while `ackedEnd + 1 < file.size`, `waitWhilePaused()`, slice `start = ackedEnd + 1`, `end = min(start + chunk_size, size) - 1`, `putChunk` with `Content-Range: bytes ${start}-${end}/${size}`. On failure retry that range **3** times with delays **1000, 2000, 4000** ms (`sleep`). HTTP **401** → throw `SessionExpiredError` (do not retry). HTTP **404/410** after a session was live: throw a restartable error the tray maps to “had to restart”.
    - `onProgress` uses `(ackedEnd + 1) / file.size * 100` after each ack (not only XHR `loaded`).
    - After loop, `complete`. If complete fails, Retry calls `transport.complete(uploadId)` only. Return `{ mode, uploadId }` so the tray can do that.

`api.ts`:
- `errorCode(body: unknown): string | null` — `detail.error.code` or `detail.code`
- `startUpload(brand, folderId, {filename, size, content_type})` via `request()`
- `completeUpload(brand, uploadId)` via `request()`
- `putChunk(brand, uploadId, blob, contentRange, onProgress, signal)` via XHR PUT (progress + abort)
- `upload(...)` existing FormData POST stays; add `signal?: AbortSignal` (`xhr.abort()` on abort)
- Do **not** treat chunk/start/complete 401 as login redirect (`isSessionEndpoint` unchanged)

When `request()` throws, attach `code` from `errorCode` onto `ApiError` (`error.code = ...`) so `uploadFile` can see `CHUNK_UPLOAD_UNAVAILABLE`.

- [ ] **Step 1: Add Vitest and write failing tests**

`npm install -D vitest` in `frontend/`. Script: `"test": "vitest run"`. In `vite.config.ts`:

```ts
test: { environment: "node", include: ["src/**/*.test.ts"] },
```

`chunkedUpload.test.ts` (inject a fake transport; no network):

```ts
import { describe, expect, it, vi } from "vitest";
import { SIMPLE_UPLOAD_MAX, STREAM_FALLBACK_MAX } from "./constants";
import { SessionExpiredError, uploadFile } from "./chunkedUpload";

function fileOf(size: number, name = "a.bin"): File {
  return new File([new Uint8Array(size)], name);
}

describe("uploadFile", () => {
  it("uses simple upload under 10 MiB", async () => {
    const simpleUpload = vi.fn().mockResolvedValue(undefined);
    const result = await uploadFile({
      brand: "haute_brands",
      folderId: "fld",
      file: fileOf(SIMPLE_UPLOAD_MAX - 1),
      transport: {
        start: vi.fn(),
        putChunk: vi.fn(),
        complete: vi.fn(),
        simpleUpload,
      },
      onProgress: vi.fn(),
      isPaused: () => false,
      signal: new AbortController().signal,
      waitWhilePaused: async () => undefined,
    });
    expect(result.mode).toBe("simple");
    expect(simpleUpload).toHaveBeenCalledOnce();
  });

  it("sends sequential ranges then complete", async () => {
    const ranges: string[] = [];
    const result = await uploadFile({
      brand: "haute_brands",
      folderId: "fld",
      file: fileOf(12 * 1024 * 1024),
      transport: {
        start: vi.fn().mockResolvedValue({ upload_id: "uid", chunk_size: 8 * 1024 * 1024 }),
        putChunk: vi.fn(async (_id, _blob, contentRange) => {
          ranges.push(contentRange);
          const m = /bytes (\d+)-(\d+)\//.exec(contentRange)!;
          return { acked_end: Number(m[2]) };
        }),
        complete: vi.fn().mockResolvedValue(undefined),
        simpleUpload: vi.fn(),
      },
      onProgress: vi.fn(),
      isPaused: () => false,
      signal: new AbortController().signal,
      waitWhilePaused: async () => undefined,
    });
    expect(result.mode).toBe("chunked");
    expect(ranges[0]).toMatch(/^bytes 0-/);
    expect(ranges).toHaveLength(2);
  });

  it("falls back when start returns CHUNK_UPLOAD_UNAVAILABLE", async () => {
    const err = Object.assign(new Error("nope"), { code: "CHUNK_UPLOAD_UNAVAILABLE", status: 503 });
    const simpleUpload = vi.fn().mockResolvedValue(undefined);
    const result = await uploadFile({
      brand: "haute_brands",
      folderId: "fld",
      file: fileOf(15 * 1024 * 1024),
      transport: {
        start: vi.fn().mockRejectedValue(err),
        putChunk: vi.fn(),
        complete: vi.fn(),
        simpleUpload,
      },
      onProgress: vi.fn(),
      isPaused: () => false,
      signal: new AbortController().signal,
      waitWhilePaused: async () => undefined,
    });
    expect(result.mode).toBe("fallback");
    expect(simpleUpload).toHaveBeenCalledOnce();
  });

  it("does not fall back over 2 GiB", async () => {
    const err = Object.assign(new Error("nope"), { code: "CHUNK_UPLOAD_UNAVAILABLE", status: 503 });
    const big = fileOf(1); // File.size is 1; stub size via Object.defineProperty
    Object.defineProperty(big, "size", { value: STREAM_FALLBACK_MAX + 1 });
    await expect(
      uploadFile({
        brand: "haute_brands",
        folderId: "fld",
        file: big,
        transport: {
          start: vi.fn().mockRejectedValue(err),
          putChunk: vi.fn(),
          complete: vi.fn(),
          simpleUpload: vi.fn(),
        },
        onProgress: vi.fn(),
        isPaused: () => false,
        signal: new AbortController().signal,
        waitWhilePaused: async () => undefined,
      })
    ).rejects.toThrow(/2 GiB/i);
  });

  it("retries a failed chunk then acks", async () => {
    const size = SIMPLE_UPLOAD_MAX;
    const file = fileOf(size);
    let calls = 0;
    const put = vi.fn(async (_id: string, _b: Blob, range: string) => {
      calls += 1;
      if (calls === 1) throw new Error("net");
      const m = /bytes (\d+)-(\d+)\//.exec(range)!;
      return { acked_end: Number(m[2]) };
    });
    await uploadFile({
      brand: "haute_brands",
      folderId: "fld",
      file,
      transport: {
        start: vi.fn().mockResolvedValue({ upload_id: "uid", chunk_size: size }),
        putChunk: put,
        complete: vi.fn(),
        simpleUpload: vi.fn(),
      },
      onProgress: vi.fn(),
      isPaused: () => false,
      signal: new AbortController().signal,
      waitWhilePaused: async () => undefined,
      sleep: async () => undefined,
    });
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("maps 401 to SessionExpiredError without retry", async () => {
    const err = Object.assign(new Error("no"), { status: 401 });
    await expect(
      uploadFile({
        brand: "haute_brands",
        folderId: "fld",
        file: fileOf(SIMPLE_UPLOAD_MAX),
        transport: {
          start: vi.fn().mockResolvedValue({ upload_id: "uid", chunk_size: SIMPLE_UPLOAD_MAX }),
          putChunk: vi.fn().mockRejectedValue(err),
          complete: vi.fn(),
          simpleUpload: vi.fn(),
        },
        onProgress: vi.fn(),
        isPaused: () => false,
        signal: new AbortController().signal,
        waitWhilePaused: async () => undefined,
        sleep: async () => undefined,
      })
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/sahilkhatri/Work/storage/frontend && npx vitest run src/upload/chunkedUpload.test.ts
```

Expected: FAIL module not found.

- [ ] **Step 3: Write `constants.ts`, `chunkedUpload.ts`, and `api.ts` transport wrappers**

Implement `uploadFile` exactly as Interfaces. `waitWhilePaused` is a promise that resolves when `isPaused()` becomes false (App will drive this with a resolver). Inside the loop, `await waitWhilePaused()` before each chunk.

Wire `makeTransport(brand): ChunkTransport` in `api.ts` (or in `chunkedUpload.ts` importing `api`) so App does not reimplement XHR.

- [ ] **Step 4: Run tests to verify they pass**

`npx vitest run`

Also `npx tsc -b` so `api.ts` still typechecks.

- [ ] **Step 5: Commit** (storage)

```bash
git add frontend/package.json frontend/package-lock.json frontend/vite.config.ts frontend/src/upload frontend/src/api.ts
git commit -m "feat: chunked upload client with fallback and retries"
```

---

### Task 9: Serial queue, tray pause/resume, keep-alive

**Files:**
- Create: `/Users/sahilkhatri/Work/storage/frontend/src/upload/queue.ts`
- Create: `/Users/sahilkhatri/Work/storage/frontend/src/upload/queue.test.ts`
- Modify: `/Users/sahilkhatri/Work/storage/frontend/src/App.tsx`
- Modify: `/Users/sahilkhatri/Work/storage/frontend/src/components/UploadTray.tsx`
- Modify: `/Users/sahilkhatri/Work/storage/frontend/src/styles.css`

**Interfaces:**
- Produces:
  - `export function createSerialQueue(): { enqueue(job: () => Promise<void>): void; size: () => number }` — one job at a time; errors in a job must not skip draining the rest (`try/finally`).
  - `Upload` gains: `mode?: "chunked" | "simple" | "fallback"`; `paused?: boolean`; `message?: string`
  - Tray: Pause / Resume when `status === "uploading"` and `mode === "chunked"`; no Pause when `mode === "fallback"` or `"simple"`; Retry when `status === "failed"`; failed copy for session expiry vs restart
  - App: `doUpload` enqueues each file instead of firing parallel `api.upload` calls. Keep-alive: while any row is `uploading`, `setInterval(() => { void api.me(); }, 4 * 60 * 1000)`. `beforeunload` when any `uploading`. Pause sets `paused: true` and the `waitWhilePaused` resolver. Cancel/abort uses `AbortController` per job.

- [ ] **Step 1: Write the failing queue test**

```ts
import { describe, expect, it } from "vitest";
import { createSerialQueue } from "./queue";

describe("createSerialQueue", () => {
  it("runs jobs one at a time in FIFO order", async () => {
    const order: number[] = [];
    const q = createSerialQueue();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    q.enqueue(async () => {
      order.push(1);
      await gate;
    });
    q.enqueue(async () => {
      order.push(2);
    });
    await Promise.resolve();
    expect(order).toEqual([1]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL cannot find module.

- [ ] **Step 3: Implement queue + App + tray**

`doUpload` today starts every file immediately — replace with enqueue. Track `controllers: Map<number, AbortController>` and `pauseWaiters: Map<number, () => void>`.

Retry: if last result had `uploadId` and failure was complete-only, call `api.completeUpload`. If 404/410 on chunk, `uploadFile` from byte 0 (new Start) and toast that it restarted. SessionExpiredError: message “signed out — upload must restart after you sign in.”

Tray header: if `active === 1` keep singular; queued files have `status: "uploading"` only when actually running — **queued** rows must not all be `uploading` or the header will lie. Use `status: "queued" | "uploading" | "done" | "failed"` and count `uploading` for the header; `beforeunload` if any `queued` or `uploading`. Exhaustive switch if you switch on status (include `never` default).

- [ ] **Step 4: Run tests and typecheck**

```bash
cd /Users/sahilkhatri/Work/storage/frontend && npx vitest run && npx tsc -b
```

- [ ] **Step 5: Commit** (storage)

```bash
git add frontend/src/upload/queue.ts frontend/src/upload/queue.test.ts frontend/src/App.tsx frontend/src/components/UploadTray.tsx frontend/src/styles.css
git commit -m "feat: serial upload queue with pause, resume, and session keep-alive"
```

---

### Task 10: Storage MINOR 1.2.0

**Files:**
- Modify: `/Users/sahilkhatri/Work/storage/VERSION` → `1.2.0`
- Modify: `/Users/sahilkhatri/Work/storage/frontend/package.json` `"version": "1.2.0"`
- Modify: `/Users/sahilkhatri/Work/storage/docs/VERSIONING.md` history + **Current**

**Interfaces:** none. `backend/tests/test_version.py` must pass.

- [ ] **Step 1: Bump the three version locations**

Changelog row: 2026-08-19, minor, chunked uploads with pause/resume; stream fallback for large one-shot; serial queue.

- [ ] **Step 2: Run tests**

```bash
cd /Users/sahilkhatri/Work/storage/backend && pytest tests/test_version.py tests/test_app.py -v --tb=short
cd /Users/sahilkhatri/Work/storage/frontend && npx vitest run && npx tsc -b
```

Expected: PASS, `package.json` version matches `VERSION`.

- [ ] **Step 3: Commit** (storage)

```bash
git add VERSION frontend/package.json docs/VERSIONING.md
git commit -m "chore: bump storage to 1.2.0 for chunked uploads"
```

Do not deploy unless the user asks. When deploying: Zoho service **1.38.0** first, then storage **1.2.0**. Smoke: 15MB zip should finish in chunked mode (or fallback stream) without the old multipart stall. No production upload from CI.

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| 10 MiB simple vs chunked | 1, 5, 8 |
| 8 MiB chunks / last remainder | 2, 3, 8 |
| 2 GiB fallback cap | 8 |
| Start / Chunk / Finish via storage → Zoho | 4, 7 |
| Stream fallback + large one-shot stream | 1, 5, 8 |
| No `UploadFile` on chunks / no LXC assemble | 4, 7 |
| Zoho 401 → 502; cookie 401 stays 401 | 7 |
| No Authentik bounce on chunk 401 | 8 (`isSessionEndpoint` + `SessionExpiredError`) |
| Serial queue | 9 |
| Pause / Resume same tab; close-tab abandons | 9 |
| Retry 3× 1s/2s/4s; Finish-only retry | 8, 9 |
| Keep-alive `GET /api/me` ~4 min | 9 |
| `beforeunload` | 9 |
| Tests mocked; no live prod upload | all |
| MINOR both apps | 6, 10 |
| Reuse `workdrive.upload`; no grant unless 403 | 4 |
| Out of scope (refresh resume, parallel, direct Zoho) | not scheduled |
