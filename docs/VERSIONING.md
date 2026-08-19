# Versioning Policy — Storage App

The canonical version is the `VERSION` file at the repo root. Every other
reference must match it.

| Location | How it gets the version |
|----------|-------------------------|
| `backend/app/__init__.py` | Reads `VERSION` at import time as `__version__` |
| `GET /healthz` | `{"status": "ok", "version": __version__}` |
| FastAPI `app.version` | Same `__version__` |
| `frontend/package.json` | Must be bumped in the same change as `VERSION` |
| Git tag | `v` + `VERSION` contents (e.g. `v1.1.0`) |

Follow [Semantic Versioning 2.0.0](https://semver.org): `MAJOR.MINOR.PATCH`.

- **PATCH** (`1.1.0` → `1.1.1`): bug fix, docs, tests, hardening, no new capability
- **MINOR** (`1.1.0` → `1.2.0`): new endpoint, UI capability, or backward-compatible field
- **MAJOR** (`1.x` → `2.0.0`): breaking API/auth/session contract

Bump `VERSION`, `frontend/package.json`, and this changelog in the **same
change** as the work. Do not leave version bumps for a later commit.

## Version history

| Version | Date | Type | Summary |
|---------|------|------|---------|
| 1.2.0 | 2026-08-19 | minor | Chunked uploads with pause/resume; stream fallback for large one-shot; serial queue |
| 1.1.1 | 2026-08-19 | patch | Upload tray completes after success (track by id, not object identity); last-modified no longer shows 2001 for yearless WorkDrive dates |
| 1.1.0 | 2026-08-19 | minor | Create team folder at Team Folders root; Zoho calls use Bearer; session 401 no longer login-loops; semantic versioning (`VERSION`, `/healthz`) |
| 1.0.0 | 2026-08-19 | major | Initial WorkDrive UI: Authentik OIDC, company picker, browse/search/upload/download/rename/move/trash |

**Current:** 1.2.0
