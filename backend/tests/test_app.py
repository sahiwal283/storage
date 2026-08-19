"""Smoke tests: auth gating, brand validation, session handling."""

import os

os.environ.update(
    SERVICE_URL="http://service.test",
    INTERNAL_TOKEN="test-token",
    BRANDS='[{"code": "haute_brands", "name": "Haute Brands"}]',
    OIDC_ISSUER="http://authentik.test/application/o/storage",
    OIDC_CLIENT_ID="cid",
    OIDC_CLIENT_SECRET="csec",
    PUBLIC_URL="https://storage.test",
    SECRET_KEY="unit-test-secret",
    SECURE_COOKIES="false",
)

import pytest
from httpx import ASGITransport, AsyncClient

from app import __version__, proxy
from app.auth import SESSION_COOKIE, _serializer
from app.config import get_settings
from app.main import app


def session_cookie() -> str:
    return _serializer(get_settings()).dumps(
        {"sub": "u1", "email": "u@test", "name": "U", "iat": 0}
    )


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.anyio
async def test_healthz_open(client):
    resp = await client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "version": __version__}


@pytest.mark.anyio
async def test_api_requires_session(client):
    resp = await client.get("/api/brands")
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_api_rejects_garbage_cookie(client):
    resp = await client.get("/api/brands", cookies={SESSION_COOKIE: "garbage"})
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_brands_with_session(client):
    resp = await client.get("/api/brands", cookies={SESSION_COOKIE: session_cookie()})
    assert resp.status_code == 200
    assert resp.json() == [{"code": "haute_brands", "name": "Haute Brands"}]


@pytest.mark.anyio
async def test_me_returns_session_identity(client):
    resp = await client.get("/api/me", cookies={SESSION_COOKIE: session_cookie()})
    assert resp.status_code == 200
    assert resp.json() == {"email": "u@test", "name": "U"}


@pytest.mark.anyio
async def test_unknown_brand_404(client):
    resp = await client.get(
        "/api/nope/teamfolders", cookies={SESSION_COOKIE: session_cookie()}
    )
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_spa_redirects_anonymous_to_login(client):
    resp = await client.get("/", follow_redirects=False)
    assert resp.status_code == 307
    assert resp.headers["location"] == "/auth/login"


def test_service_headers_send_app_bearer_token():
    headers = proxy._service_headers("haute_brands")
    assert headers["Authorization"] == "Bearer test-token"
    assert headers["X-Brand"] == "haute_brands"
    assert "X-Internal-Token" not in headers


class _FakeUpstream:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self.headers = {"content-type": "application/json"}
        self._body = body
        self.content = b"json"
        self.text = str(body)

    def json(self):
        return self._body


@pytest.mark.anyio
async def test_upstream_401_does_not_look_like_missing_session(client, monkeypatch):
    """Zoho 401 must not surface as 401 or the SPA login-loops through Authentik."""
    captured = {}

    class FakeClient:
        async def request(self, method, url, params=None, json=None, headers=None):
            captured["headers"] = headers
            return _FakeUpstream(
                401,
                {
                    "detail": {
                        "error": {
                            "code": "ZOHO_AUTH_INVALID",
                            "message": "Authorization required",
                        }
                    }
                },
            )

    monkeypatch.setattr(proxy, "get_client", lambda: FakeClient())
    resp = await client.get(
        "/api/haute_brands/teamfolders", cookies={SESSION_COOKIE: session_cookie()}
    )
    assert captured["headers"]["Authorization"] == "Bearer test-token"
    assert resp.status_code == 502
    assert resp.status_code != 401


@pytest.mark.anyio
async def test_upstream_404_passes_through(client, monkeypatch):
    class FakeClient:
        async def request(self, method, url, params=None, json=None, headers=None):
            return _FakeUpstream(
                404,
                {
                    "detail": {
                        "error": {
                            "code": "NO_CREDENTIALS",
                            "message": "No OAuth credentials for Zoho WorkDrive.",
                        }
                    }
                },
            )

    monkeypatch.setattr(proxy, "get_client", lambda: FakeClient())
    resp = await client.get(
        "/api/haute_brands/teamfolders", cookies={SESSION_COOKIE: session_cookie()}
    )
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_create_teamfolder_forwards_post(client, monkeypatch):
    captured = {}

    class FakeClient:
        async def request(self, method, url, params=None, json=None, headers=None):
            captured["method"] = method
            captured["url"] = url
            captured["json"] = json
            captured["headers"] = headers
            return _FakeUpstream(
                200,
                {"ok": True, "item": {"id": "tf-new", "name": "Legal"}},
            )

    monkeypatch.setattr(proxy, "get_client", lambda: FakeClient())
    resp = await client.post(
        "/api/haute_brands/teamfolders",
        json={"name": "Legal"},
        cookies={SESSION_COOKIE: session_cookie()},
    )
    assert resp.status_code == 200
    assert captured["method"] == "POST"
    assert captured["url"].endswith("/zoho/workdrive/teamfolders")
    assert captured["json"] == {"name": "Legal"}
    assert captured["headers"]["Authorization"] == "Bearer test-token"


@pytest.mark.anyio
async def test_start_upload_forwards_json(client, monkeypatch):
    captured = {}

    class FakeClient:
        async def request(
            self, method, url, params=None, json=None, headers=None, content=None
        ):
            captured.update(method=method, url=url, json=json, headers=headers)
            return _FakeUpstream(
                200, {"ok": True, "upload_id": "uid-1", "chunk_size": 8388608}
            )

    monkeypatch.setattr(proxy, "get_client", lambda: FakeClient())
    resp = await client.post(
        "/api/haute_brands/folders/fld-1/uploads",
        json={
            "filename": "a.bin",
            "size": 15_000_000,
            "content_type": "application/octet-stream",
        },
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
        async def request(
            self, method, url, params=None, json=None, headers=None, content=None
        ):
            captured.update(method=method, url=url, headers=headers)
            captured["content"] = content
            return _FakeUpstream(200, {"ok": True, "acked_end": 3})

    monkeypatch.setattr(proxy, "get_client", lambda: FakeClient())
    resp = await client.put(
        "/api/haute_brands/uploads/uid-1/chunks",
        content=b"abcd",
        headers={
            "Content-Range": "bytes 0-3/10",
            "Content-Type": "application/octet-stream",
        },
        cookies={SESSION_COOKIE: session_cookie()},
    )
    assert resp.status_code == 200
    assert captured["method"] == "PUT"
    assert captured["url"].endswith("/zoho/workdrive/uploads/uid-1/chunks")
    assert captured["headers"]["content-range"] == "bytes 0-3/10"


@pytest.mark.anyio
async def test_chunk_upstream_401_is_502(client, monkeypatch):
    class FakeClient:
        async def request(
            self, method, url, params=None, json=None, headers=None, content=None
        ):
            return _FakeUpstream(
                401, {"detail": {"error": {"code": "ZOHO_AUTH_INVALID"}}}
            )

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
        async def request(
            self, method, url, params=None, json=None, headers=None, content=None
        ):
            captured.update(method=method, url=url)
            return _FakeUpstream(
                200, {"ok": True, "item": {"id": "f1", "name": "a.bin"}}
            )

    monkeypatch.setattr(proxy, "get_client", lambda: FakeClient())
    resp = await client.post(
        "/api/haute_brands/uploads/uid-1/complete",
        cookies={SESSION_COOKIE: session_cookie()},
    )
    assert resp.status_code == 200
    assert captured["url"].endswith("/zoho/workdrive/uploads/uid-1/complete")


@pytest.fixture
def anyio_backend():
    return "asyncio"
