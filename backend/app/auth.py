"""Authentik OIDC login and signed-cookie sessions."""

import time
from typing import Optional

import httpx
from authlib.integrations.httpx_client import AsyncOAuth2Client
from authlib.jose import jwt
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, URLSafeTimedSerializer

from .config import Settings, get_settings

SESSION_COOKIE = "storage_session"
STATE_COOKIE = "storage_oidc_state"

router = APIRouter()

_metadata: Optional[dict] = None
_jwks: Optional[dict] = None


def _serializer(settings: Settings) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(settings.secret_key, salt="storage-session")


async def _discover(settings: Settings) -> dict:
    global _metadata
    if _metadata is None:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{settings.oidc_issuer}/.well-known/openid-configuration"
            )
            resp.raise_for_status()
            _metadata = resp.json()
    return _metadata


async def _get_jwks(settings: Settings) -> dict:
    global _jwks
    if _jwks is None:
        meta = await _discover(settings)
        async with httpx.AsyncClient() as client:
            resp = await client.get(meta["jwks_uri"])
            resp.raise_for_status()
            _jwks = resp.json()
    return _jwks


def get_session(request: Request) -> dict:
    settings = get_settings()
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return _serializer(settings).loads(token, max_age=settings.session_max_age)
    except BadSignature:
        raise HTTPException(status_code=401, detail="Session invalid or expired")


def _redirect_uri(settings: Settings) -> str:
    return f"{settings.public_url}/auth/callback"


@router.get("/auth/login")
async def login(request: Request):
    settings = get_settings()
    meta = await _discover(settings)
    client = AsyncOAuth2Client(
        settings.oidc_client_id,
        settings.oidc_client_secret,
        scope="openid profile email",
        redirect_uri=_redirect_uri(settings),
    )
    url, state = client.create_authorization_url(meta["authorization_endpoint"])
    resp = RedirectResponse(url)
    resp.set_cookie(
        STATE_COOKIE,
        state,
        max_age=600,
        httponly=True,
        secure=settings.secure_cookies,
        samesite="lax",
    )
    return resp


@router.get("/auth/callback")
async def callback(request: Request):
    settings = get_settings()
    meta = await _discover(settings)
    state = request.query_params.get("state")
    if not state or state != request.cookies.get(STATE_COOKIE):
        raise HTTPException(status_code=400, detail="OIDC state mismatch")

    client = AsyncOAuth2Client(
        settings.oidc_client_id,
        settings.oidc_client_secret,
        redirect_uri=_redirect_uri(settings),
    )
    token = await client.fetch_token(
        meta["token_endpoint"], authorization_response=str(request.url), state=state
    )

    jwks = await _get_jwks(settings)
    claims = jwt.decode(token["id_token"], jwks)
    claims.validate()
    # Validate iss against the IdP's authoritative discovery value — resilient
    # to Authentik global vs per-provider issuer modes.
    expected_iss = str(meta.get("issuer", "")).rstrip("/")
    if str(claims.get("iss", "")).rstrip("/") != expected_iss or (
        settings.oidc_client_id not in _as_list(claims.get("aud"))
    ):
        raise HTTPException(status_code=400, detail="Invalid id_token")

    session = {
        "sub": claims["sub"],
        "email": claims.get("email", ""),
        "name": claims.get("name") or claims.get("preferred_username", ""),
        "iat": int(time.time()),
    }
    resp = RedirectResponse("/")
    resp.set_cookie(
        SESSION_COOKIE,
        _serializer(settings).dumps(session),
        max_age=settings.session_max_age,
        httponly=True,
        secure=settings.secure_cookies,
        samesite="lax",
    )
    resp.delete_cookie(STATE_COOKIE)
    return resp


def _as_list(value) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


@router.post("/auth/logout")
async def logout(response: Response):
    resp = Response(status_code=204)
    resp.delete_cookie(SESSION_COOKIE)
    return resp
