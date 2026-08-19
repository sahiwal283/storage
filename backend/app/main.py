from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import auth, proxy

app = FastAPI(title="Storage", docs_url=None, redoc_url=None)

app.include_router(auth.router)
app.include_router(proxy.router)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


if (STATIC_DIR / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")


@app.get("/{full_path:path}")
async def spa(full_path: str, request: Request):
    """Serve the SPA; unauthenticated users go straight to login."""
    if full_path.startswith(("api/", "auth/")):
        return RedirectResponse("/")
    index = STATIC_DIR / "index.html"
    if not index.is_file():
        return {"detail": "Frontend not built"}
    if auth.SESSION_COOKIE not in request.cookies:
        return RedirectResponse("/auth/login")
    return FileResponse(index)
