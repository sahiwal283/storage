import json
import os
from functools import lru_cache

from pydantic import BaseModel


class Brand(BaseModel):
    code: str
    name: str


class Settings(BaseModel):
    service_url: str
    internal_token: str
    brands: list[Brand]
    oidc_issuer: str
    oidc_client_id: str
    oidc_client_secret: str
    public_url: str
    secret_key: str
    session_max_age: int = 12 * 3600
    # Set false only for local dev over plain http
    secure_cookies: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings(
        service_url=os.environ["SERVICE_URL"].rstrip("/"),
        internal_token=os.environ["INTERNAL_TOKEN"],
        brands=[Brand(**b) for b in json.loads(os.environ["BRANDS"])],
        oidc_issuer=os.environ["OIDC_ISSUER"].rstrip("/"),
        oidc_client_id=os.environ["OIDC_CLIENT_ID"],
        oidc_client_secret=os.environ["OIDC_CLIENT_SECRET"],
        public_url=os.environ["PUBLIC_URL"].rstrip("/"),
        secret_key=os.environ["SECRET_KEY"],
        secure_cookies=os.environ.get("SECURE_COOKIES", "true").lower() != "false",
    )
