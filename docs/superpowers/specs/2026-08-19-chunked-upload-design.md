# Chunked WorkDrive uploads (Design Spec)

Date: 2026-08-19
Status: Approved in brainstorming (architecture, tray, errors, testing)

Repos:

- Storage app (this repo): UI, session cookie, proxy
- Zoho Integration Service (`services/zoho-integration-service`): WorkDrive OAuth and upstream calls

Storage never talks to Zoho. The browser never talks to Zoho. All WorkDrive traffic stays on LXC 9503.

## Goal

Designers can upload multi-GB files without starting over on a Wi-Fi blip, and without waiting on WorkDrive’s slow small-file multipart API (the path that made a 15MB zip feel stuck).

Success looks like:

- Files under 10 MiB still use today’s one-shot multipart upload
- Files 10 MiB and larger upload in chunks, with **Pause / Resume** in the tray while the tab stays open
- Several files **queue one at a time**
- Closing the tab abandons the upload (no resume-after-refresh)
- If WorkDrive’s chunk API cannot be started, files **≥ 10 MiB and ≤ 2 GiB** fall back to a single **stream** upload (Approach 1). Pause is not available on that fallback.

## Decisions (from brainstorming)

| Topic | Choice |
|-------|--------|
| Size / resume | Multi-GB; same-tab pause/resume; close-tab starts over |
| Queue | Serial — one active upload, rest wait |
| Architecture | Chunked through storage → Zoho service (Approach 2) |
| Fallback | Whole-file stream API if chunk **Start** is unavailable (Approach 1) |
| Direct browser → Zoho | Out of scope |

## Cutoffs (explicit)

- **Simple multipart:** `file.size < 10 MiB` (`10 * 1024 * 1024`)
- **Chunked (default for large files):** `file.size >= 10 MiB`
- **Chunk payload size:** 8 MiB (`8 * 1024 * 1024`). Last chunk is the remainder. If WorkDrive documents a required multiple, use that multiple and keep it ≥ 4 MiB.
- **Stream fallback max:** 2 GiB (`2048 * 1024 * 1024`), matching NPM Plus `client_max_body_size 2048M`. A file larger than 2 GiB **cannot** use fallback; if chunk Start fails, the tray fails with a clear message (do not send a 8GB POST and get a cryptic 413).
- **Hard ceiling:** WorkDrive plan limit (documented up to 250GB). Surface Zoho’s error; do not invent a second cap.

## Architecture

```
Small file:  Browser  --multipart POST-->  Storage  -->  Zoho service  -->  workdrive.zoho.{tld}/api/v1/upload

Large file:  Browser  --Start-->  Storage  -->  Zoho service  -->  WorkDrive chunk session
             Browser  --chunk N (raw + Content-Range)-->  Storage  -->  Zoho service  -->  WorkDrive
             Browser  --Finish-->  Storage  -->  Zoho service  -->  commit file

Fallback:    Browser  --one stream POST-->  Storage  -->  Zoho service  -->  upload.zoho.{tld}/workdrive-api/v1/stream/upload
```

Each chunk is streamed. Starlette `UploadFile` is **not** used for chunks (that spools to disk). Storage already streams the current upload body with `request.stream()`; chunk PUT uses the same pattern: copy `content-type`, `content-length`, and `content-range`, forward bytes.

WorkDrive’s public explorer for “chunk upload” is JS-only. The **app contract is the three endpoints below**. The Zoho client maps them onto the official chunk API (session + byte ranges). If that wire format is actually `POST .../stream/upload` with a stable `upload-id` and `Content-Range`, that is an implementation detail behind the same three endpoints — not a second UI protocol.

Do **not** assemble the file on either LXC.

## Endpoints

Storage proxies 1:1 to the Zoho service (session cookie in, `Authorization: Bearer` + `X-Brand` out). Zoho 401 from upstream stays **502** (must not look like a missing Storage session). Missing/invalid `storage_session` stays **401**.

### Start

`POST /api/{brand}/folders/{folder_id}/uploads`  
→ `POST /zoho/workdrive/folders/{folder_id}/uploads`

JSON body:

```json
{ "filename": "deck.psd", "size": 1234567890, "content_type": "image/vnd.adobe.photoshop" }
```

JSON response:

```json
{ "upload_id": "<workdrive-or-service-id>", "chunk_size": 8388608 }
```

Name-clash policy matches today’s simple upload (`override-name-exist` default unchanged). Pass it through as a query flag on Start if the simple upload route already exposes it; do not add a new overwrite UI in this change.

If WorkDrive’s chunk API is missing or not configured (404, `URL_RULE_NOT_CONFIGURED`, or equivalent), the Zoho service returns **503** with a typed body:

```json
{ "detail": { "code": "chunk_upload_unavailable", "message": "..." } }
```

The frontend treats only that code as “use stream fallback.” Other 4xx/5xx on Start are hard failures.

### Chunk

`PUT /api/{brand}/uploads/{upload_id}/chunks`  
→ `PUT /zoho/workdrive/uploads/{upload_id}/chunks`

- Headers: `Content-Type: application/octet-stream`, `Content-Range: bytes start-end/total`, `Content-Length`
- Body: raw slice (`File.slice(start, end + 1)`)
- 2xx means that range is **acked**. Response may include `{ "acked_end": end }` (inclusive). Progress percent uses the highest acked byte, not `xhr.upload` bytes that only left the browser.
- Timeouts: keep the existing 30s connect / 600s read on the storage→service client; 8 MiB must finish well inside that.

### Finish

`POST /api/{brand}/uploads/{upload_id}/complete`  
→ `POST /zoho/workdrive/uploads/{upload_id}/complete`

Returns the same normalized file item shape as create/list (`id`, `name`, `type`, `size`, `modified_time`, …). The UI refreshes the folder the same way a successful simple upload does.

No abort/cancel endpoint in this version. Cancel = stop sending chunks (abort in-flight XHR). WorkDrive expires the unused session.

## Fallback (Approach 1)

Triggered only when Start returns `chunk_upload_unavailable` **and** `file.size <= 2 GiB`.

The existing `POST /api/{brand}/folders/{folder_id}/upload` stays. On the Zoho service, that handler uses:

- multipart `content` → `{api_base}/upload` when size is under 10 MiB
- stream → `{upload_base}/stream/upload` (`x-filename`, `x-parent_id`, `x-streammode: 1`, `upload-id`, `application/octet-stream`) when size ≥ 10 MiB

So fallback is fast, and any leftover one-shot large POST is fast too.

Files over 2 GiB with `chunk_upload_unavailable`: fail in the tray. Do not attempt the 2 GiB-capped POST.

## Frontend (tray and queue)

Files: `frontend/src/api.ts`, `App.tsx`, `UploadTray.tsx` (and types/styles as needed).

- Keep tracking rows by numeric `id` (not object identity).
- Drop/pick N files: FIFO queue; **one** `status: "uploading"` at a time.
- `file.size < 10 MiB`: existing FormData XHR to `/upload`.
- `file.size >= 10 MiB`: Start → loop PUT chunks → Finish.
- **Pause:** after the in-flight chunk XHR settles (success, fail, or abort), do not start the next range. Button becomes Resume.
- **Resume:** PUT from `acked_end + 1`.
- **Failed chunk:** retry that range up to **3** times with backoff **1s, 2s, 4s**. Pause still applies when the attempt finishes. Then the row is `failed`.
- **Retry** on a failed row: continue from `acked_end + 1` (or Finish-only if every byte was acked). If that call returns session-gone (404/410 or equivalent), Start again from byte 0 and the tray says the upload had to restart.
- **Fallback row:** no Pause; Cancel aborts the XHR; short note that this file is a single-shot upload.
- `beforeunload` when any row is `uploading`.
- Out of scope: resume after refresh, folder-tree drop as one archive, parallel streams, changing destination folder mid-upload.

## Error handling

| Event | Behavior |
|-------|----------|
| Chunk timeout / 5xx / network | Retry that range (3×). Then fail the row. |
| Finish fails after all chunks acked | Retry calls Finish only. |
| Storage session 401 on a chunk | **Do not** redirect the SPA to Authentik. Fail the row: signed out, must restart after sign-in. |
| Keep-alive | While any large upload is in flight, `GET /api/me` about every 4 minutes so the cookie does not silently expire. |
| Zoho 401 on proxy | 502, as today. |
| Plan limit / no permission / folder gone | No retry storm. Fail the row with Zoho’s message. |
| NPM 413 / size over 2 GiB on fallback | Fail with a readable message; do not retry as simple upload. |

## Testing

**Zoho service (pytest, mocked WorkDrive):**

- Start + two chunks (full size + short last chunk) + Finish → one file
- Finish-only retry after a failed complete
- Mid-file 5xx on chunk 1: caller retries that `Content-Range`, does not restart
- Start → `chunk_upload_unavailable` (404 / URL rule)
- Existing small multipart upload tests still pass
- Large one-shot `/upload` uses stream host, not `{api_base}/upload`

**Storage:**

- Start / chunk / Finish proxy mapping
- Zoho 401 on those routes → 502
- Missing cookie → 401
- Existing small-file upload test still passes

**Frontend:**

- Queue is serial
- Pause does not start the next chunk
- Percent uses acked bytes
- Fallback row has no Pause

No live upload to production as the proof. A local large-file check happens only after implementation is approved and deployed to the usual LXC.

## Versioning (implementation commit, not this spec)

This is a new user-facing capability → **MINOR** on both apps, in the same change as the code:

- Storage: `VERSION`, `frontend/package.json`, `docs/VERSIONING.md`
- Zoho Integration Service: its usual `VERSION` / changelog

This spec-only commit does not bump versions.

## Out of scope

- Resume after tab close or refresh (would require re-picking the file and persisted session ids)
- Parallel uploads
- Browser or storage app calling Zoho directly
- Staging/reassembling multi-GB files on either LXC
- New overwrite-vs-rename UI
- Abort/expire API for abandoned WorkDrive sessions

## Implementation notes (not extra product)

- Possible extra WorkDrive OAuth scope: only if chunk Start fails for scope reasons. Prefer existing `WorkDrive.files.ALL`. If re-consent is required, it is an admin step on the Zoho service OAuth UI — same pattern as the original WorkDrive enablement.
- Grant script: if the service gates new routes as separate capabilities, grant them to `storage-app` for all three brands.
- NPM timeouts already 600s; chunk size is chosen so we do not need a NPM change for the default path.
