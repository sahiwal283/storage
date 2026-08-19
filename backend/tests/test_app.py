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


@pytest.fixture
def anyio_backend():
    return "asyncio"
