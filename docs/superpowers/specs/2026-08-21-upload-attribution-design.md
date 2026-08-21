# App-user upload attribution (Design Spec)

Date: 2026-08-21
Status: Approved in brainstorming (architecture, writes/overlay, UI, testing)

Repo: Storage app (this repo) only.

The Zoho Integration Service does not change. It keeps talking to WorkDrive and
returning WorkDrive’s `created_by`. Storage never sends Authentik identity
upstream.

Authentik OIDC is already how the app signs in (`storage_session` with `sub`,
`name`, `email`). This feature uses that session; it does not add SSO.

## Goal

In the storage app, a file or folder created through the app shows the
Authentik user who created it, not the shared Zoho WorkDrive account. Items
already in WorkDrive, and items created in WorkDrive directly, keep the Zoho
name.

Success looks like:

- After an app upload or folder create, the list subtitle and details rail
  show that user’s display name
- Hover shows their email when we have an attribution row
- Existing items still show the Zoho `created_by`
- WorkDrive itself is unchanged

## Decisions (from brainstorming)

| Topic | Choice |
|-------|--------|
| History | New work only. Existing items keep the Zoho name |
| Visibility | Storage app only. Do not stamp WorkDrive |
| Display | Authentik `name`, fallback `email`. Hover = email |
| Store | SQLite in the storage app. Zoho service does not remember users |
| Auth | Existing Authentik OIDC session. No SSO work |
| Modified-by | Out of scope. Stays the Zoho name |

## Architecture

```
Browser  --session cookie-->  Storage
  writes:  upload / folder / team-folder create
           → proxy to Zoho service as today
           → on 200 with WorkDrive id, INSERT attribution row
  reads:   children / search
           → proxy to Zoho service as today
           → overlay created_by from SQLite when a row exists
```

Zoho Integration Service is a WorkDrive adapter. Attribution is an app
concern: identity already lives in storage’s session.

SQLite file lives **outside** the deploy tarball so deploys do not clobber it:

- Production: `/opt/storage-app/data/attribution.db`
- Local: `data/attribution.db` at the repo root (gitignored)

`CREATE TABLE IF NOT EXISTS` on startup. WAL mode. No Postgres, no Alembic.

### Schema

```sql
CREATE TABLE attribution (
  resource_id TEXT PRIMARY KEY,
  actor_sub   TEXT NOT NULL,
  actor_name  TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
```

`resource_id` is the WorkDrive file or folder id. `actor_name` is
`session["name"]` if non-empty, else `session["email"]`. `actor_email` is
`session["email"]` (may be empty). `actor_sub` is the OIDC subject. Duplicate
`resource_id` is a no-op (`INSERT OR IGNORE`).

## Writes

Stamp only after Zoho returns HTTP 200 with a WorkDrive `id` (`item.id`):

| Storage route | When |
|---------------|------|
| `POST /api/{brand}/folders/{folder_id}/upload` | one-shot upload |
| `POST /api/{brand}/uploads/{upload_id}/complete` | chunked upload finish (not Start/Chunk) |
| `POST /api/{brand}/folders` | folder create |
| `POST /api/{brand}/teamfolders` | team-folder create |

Actor comes from `get_session()` on that request. The browser does not send
the name. Failed or non-200 Zoho responses insert nothing.

If WorkDrive succeeds and SQLite insert fails, the user-facing call still
succeeds (file/folder exists). Log the insert failure. The list then shows
the Zoho name, same as today.

Rename and move keep the same WorkDrive id; the row still applies. Delete
does not remove the row (orphan is harmless).

## Reads

Intercept JSON from:

- `GET /api/{brand}/folders/{folder_id}/children`
- `GET /api/{brand}/search`

Those payloads are `{ ok, items: [ { id, created_by, ... }, ... ] }`. For each
element of `items`, if `id` is in the table:

- `created_by` ← `actor_name`
- `created_by_email` ← `actor_email`

Miss: leave WorkDrive’s `created_by`; do not add `created_by_email`.

Successful create/upload responses also overlay the returned `item` (and the
duplicate `file` / `folder` / `teamfolder` alias when present) so the object
the client just created already has the app user.

`GET /api/{brand}/teamfolders` is not overlaid. The root Team Folders view
does not show an uploader line.

## UI

Existing `created_by` rendering stays. Overlaying the field is enough for the
name.

- Files: `Uploaded by {name}`
- Folders: `Created by {name}`
- Tooltip: email only when `created_by_email` is present
- Root team-folder list: no uploader line (unchanged)
- After create, the next children/search fetch shows the overlay. The client
  does not invent a name locally
- `modified_by` is unchanged (Zoho name)

## Errors

| Case | Behavior |
|------|----------|
| No session | Existing 401. No stamp |
| Zoho create fails | No row. Surface Zoho error as today |
| SQLite insert fails after Zoho 200 | Log; still return 200 to the client |
| SQLite overlay fails on list | Log; return un-overlaid Zoho payload (Zoho names) |
| Duplicate resource_id | Ignore |

Do not fail an upload because attribution could not be recorded.

## Testing

Backend (session cookie, fake Zoho JSON — no live WorkDrive):

- Successful upload / folder create / team-folder create inserts a row keyed
  by `item.id` with the session name (email if name empty)
- Failed Zoho call inserts nothing
- Duplicate `resource_id` does not error
- Children and search overlay `created_by` and `created_by_email` on hits;
  misses keep the Zoho name
- Insert failure after a successful upload still returns 200
- Overlay failure still returns 200 with Zoho `created_by`

Frontend:

- File subtitle `Uploaded by …`
- Folder subtitle `Created by …`
- Tooltip is the email only when `created_by_email` is set

Not in scope: Zoho service tests, live WorkDrive, backfill.

## Version

MINOR: new user-visible capability (who created an item in the app).

Bump `VERSION`, `frontend/package.json`, and `docs/VERSIONING.md` in the same
change as the implementation, to **1.3.0**.

## Out of scope

- Zoho Integration Service schema or APIs for users
- Stamping WorkDrive descriptions or custom properties
- Backfill of existing files
- Tracking `modified_by`
- New Authentik SSO work
- Restricting the app by Authentik group
