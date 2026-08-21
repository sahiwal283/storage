# Upload Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the Authentik user who created a file or folder in the storage app, while leaving WorkDrive and the Zoho Integration Service unchanged.

**Architecture:** SQLite in the storage app, keyed by WorkDrive resource id. After a successful create/upload proxy response, insert a row from the signed session. On children/search (and the create payload), overlay `created_by` / `created_by_email`. Zoho never sees the app user.

**Tech Stack:** FastAPI, stdlib `sqlite3`, pytest/anyio, React + Vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-upload-attribution-design.md`

## Global Constraints

- Storage repo only. No Zoho Integration Service changes.
- SQLite path: env `ATTRIBUTION_DB`, else `<repo>/data/attribution.db` (production: `/opt/storage-app/data/attribution.db`).
- `INSERT OR IGNORE`. Insert/overlay failures must not fail the user request.
- Display name: session `name` if non-empty, else `email`. Hover = email.
- Files: `Uploaded by {name}`. Folders: `Created by {name}`.
- Version **1.3.0** in the same change as the implementation.
- TDD: failing test before production code.

## File map

- Create: `backend/app/attribution.py` — sqlite schema, record, overlay
- Create: `backend/tests/test_attribution.py` — store + overlay unit tests
- Modify: `backend/app/proxy.py` — stamp on create/upload; overlay on children/search
- Modify: `backend/app/main.py` — init db on startup
- Modify: `backend/tests/test_app.py` — isolated `ATTRIBUTION_DB`; proxy integration tests
- Modify: `frontend/src/types.ts` — `created_by_email`
- Modify: `frontend/src/format.ts` — `createdBySubtitle`
- Create: `frontend/src/format.test.ts`
- Modify: `frontend/src/components/FileList.tsx` — subtitle + title
- Modify: `.gitignore`, `deploy/deploy.sh`, `VERSION`, `frontend/package.json`, `docs/VERSIONING.md`

---

### Task 1: Attribution store

**Files:**
- Create: `backend/app/attribution.py`
- Test: `backend/tests/test_attribution.py`

**Produces:**
- `init_db() -> None`
- `record(resource_id: str, session: dict) -> None`
- `lookup(resource_ids: list[str]) -> dict[str, tuple[str, str]]`  # id → (name, email)
- `overlay_payload(body: dict) -> None`  # mutates items/item/file/folder/teamfolder
- `record_from_payload(body: dict, session: dict) -> None`

- [ ] Failing unit tests for record, name-fallback, INSERT OR IGNORE, overlay hit/miss, missing id skip
- [ ] Implement sqlite module (WAL, CREATE TABLE IF NOT EXISTS)
- [ ] pytest `backend/tests/test_attribution.py` green

### Task 2: Proxy stamp + overlay

**Files:**
- Modify: `backend/app/proxy.py`
- Modify: `backend/app/main.py`
- Modify: `backend/tests/test_app.py`

**Produces:** stamp on upload / complete / folders POST / teamfolders POST; overlay on children + search + those 200 bodies.

- [ ] Failing tests: create folder stamps and overlays; failed Zoho does not stamp; children overlay hit/miss; insert failure still 200; overlay failure still 200 with Zoho names; start/chunk do not stamp
- [ ] Wire `_forward_json` + stream upload/complete
- [ ] pytest `backend/tests/test_app.py` green

### Task 3: Frontend copy + hover

**Files:**
- Modify: `frontend/src/types.ts`, `format.ts`, `FileList.tsx`
- Test: `frontend/src/format.test.ts`

- [ ] Failing tests for file vs folder subtitle; null created_by → null
- [ ] Implement helper + FileList `title={created_by_email}`
- [ ] `npm test` in frontend green

### Task 4: Deploy path + version 1.3.0

**Files:**
- Modify: `.gitignore`, `deploy/deploy.sh`, `VERSION`, `frontend/package.json`, `docs/VERSIONING.md`

- [ ] gitignore `data/`
- [ ] `mkdir -p $APP_DIR/data` in deploy (outside tarball)
- [ ] bump 1.3.0
- [ ] pytest `test_version.py` + frontend tests green
