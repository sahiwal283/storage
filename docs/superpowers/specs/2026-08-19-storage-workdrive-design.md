# Storage App — Multi-Brand WorkDrive UI (Design Spec)

Date: 2026-08-19
Status: Approved (approach + sections 1–2 approved in chat; remaining sections follow the approved approach summary)

## Goal

A self-hosted web app at `storage.booute.duckdns.org` that gives internal users one
WorkDrive-style UI over the Zoho WorkDrive team folders of all three brands
(`haute_brands`, `boomin_brands`, `nirvana_kulture`), with a company picker to switch
brands. All Zoho traffic goes through the existing Zoho Integration Service
(LXC 9503, `192.168.1.205:8000`) — the app never calls Zoho directly.

## Decisions (from brainstorming)

- Auth: Authentik OIDC (authorization-code flow). Every logged-in user sees all brands.
- Scope: Team Folders only (no "My Folders" — service authenticates as a service account per brand).
- Operations: browse, search, download, upload, create folder, rename, move, delete
  (delete = move to WorkDrive trash; recoverable in Zoho). No in-browser preview.
- UI: replicates the WorkDrive dark UI layout/spacing/typography from the reference
  screenshot, but only functional elements — brand picker, Team Folders tree, file
  list with sort, search, New/upload, Details panel. No dead nav items. Rebuilt with
  standard icon sets; no Zoho proprietary assets.
- Architecture: "thin app" — all WorkDrive knowledge lives in the integration service
  as a first-class capability with typed endpoints (Approach 1).

## Component 1: Integration service — WorkDrive capability

New router `app/api/workdrive.py` following existing conventions (X-Internal-Token
auth, X-Brand header, capability permissions, audit logging, rate limits):

| Endpoint | Purpose |
|---|---|
| `GET /zoho/workdrive/teamfolders` | List brand's team folders |
| `GET /zoho/workdrive/folders/{id}/children` | List folder contents (+sort) |
| `GET /zoho/workdrive/files/{id}/download` | Stream file bytes down |
| `POST /zoho/workdrive/folders/{id}/upload` | Stream file up (multipart) |
| `POST /zoho/workdrive/folders` | Create folder (parent_id, name) |
| `PATCH /zoho/workdrive/files/{id}` | Rename (name) / move (parent_id) |
| `DELETE /zoho/workdrive/files/{id}` | Move to WorkDrive trash |
| `GET /zoho/workdrive/search?q=` | Search brand team |

- Streaming via httpx in both directions; no whole-file buffering.
- Per-brand WorkDrive `team_id` in the existing org config (`extra_config`), cached.
- OAuth scopes added: `WorkDrive.team.READ`, `WorkDrive.teamfolders.ALL`,
  `WorkDrive.files.ALL`. Each brand re-consents via existing admin OAuth UI (user step).
- Responses normalized: `{id, name, type, size, modified_time, modified_by, ...}`.
- WorkDrive registered as a capability; storage-app token granted read+write for all
  three brands, nothing else.

## Component 2: Storage app

One new LXC on pve (pattern: other app containers), single FastAPI process behind
systemd serving both API and built React frontend.

- Auth layer: OIDC code flow vs Authentik; signed HTTP-only session cookie; no DB,
  no server-side session store. All `/api/*` requires session.
- API layer: brand-aware passthrough. `GET /api/{brand}/...` → validates session →
  forwards to service with `X-Brand` + `X-Internal-Token` (env, never to browser).
  Uploads/downloads stream through. `GET /api/brands` returns brand list from config.
- Frontend: React + Vite, built to static files at deploy time; served by FastAPI.
- Secrets (internal token, OIDC client secret, cookie key) in env file on container.

## Component 3: Deployment

- New LXC (Ubuntu) on pve for the app; systemd unit; env file.
- NPM Plus (LXC 104): proxy host `storage.booute.duckdns.org` → app LXC, SSL like
  other `*.booute.duckdns.org` hosts.
- Authentik: new OIDC provider/application; redirect URI
  `https://storage.booute.duckdns.org/auth/callback`.

## Error handling

Service errors pass through with status codes; frontend shows toasts/banners.
Zoho token/scope problems surface as a clear "brand not connected" state per brand.

## Testing

- Service: pytest per existing test conventions (mocked Zoho client) for the new
  router; run full suite before deploy.
- App: backend tests for auth gating + passthrough mapping; manual E2E after deploy
  (login → browse → upload → download → rename/move/delete on each brand).

## User steps (cannot be automated by Claude)

1. Re-consent Zoho OAuth per brand with new WorkDrive scopes (admin UI at
   zoho.booute.duckdns.org).
2. Possibly create Authentik OIDC app if admin API unreachable.
