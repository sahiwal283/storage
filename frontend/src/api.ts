import type { Brand, DriveItem, TeamFolder } from "./types";
import type { ChunkTransport } from "./upload/chunkedUpload";

class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isSessionEndpoint(path: string): boolean {
  return path === "/api/me" || path === "/api/brands";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, init);
  // Only bounce to Authentik when our own session endpoints reject.
  // A 401 from WorkDrive passthrough is a gateway/Zoho problem; redirecting
  // it would login-loop every 1–2s because SSO completes instantly.
  if (resp.status === 401 && isSessionEndpoint(path)) {
    window.location.href = "/auth/login";
    throw new ApiError(401, "Not authenticated");
  }
  if (!resp.ok) {
    let detail = resp.statusText;
    let code: string | null = null;
    try {
      const body = await resp.json();
      detail = extractError(body) ?? detail;
      code = errorCode(body);
    } catch {
      /* keep statusText */
    }
    const error = new ApiError(resp.status, detail);
    if (code) error.code = code;
    throw error;
  }
  const body = await resp.json();
  // Service envelope: {ok, items|item, meta} — unwrap to the entity
  if (body && typeof body === "object") {
    if ("items" in body) return body.items as T;
    if ("item" in body) return body.item as T;
  }
  return body as T;
}

function extractError(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.detail === "string") return b.detail;
  const detail = b.detail as Record<string, unknown> | undefined;
  const err = (detail?.error ?? b.error) as Record<string, unknown> | undefined;
  if (err && typeof err.message === "string") return err.message;
  return null;
}

export function errorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const detail =
    root.detail && typeof root.detail === "object"
      ? (root.detail as Record<string, unknown>)
      : undefined;
  const error =
    detail?.error && typeof detail.error === "object"
      ? (detail.error as Record<string, unknown>)
      : undefined;
  if (typeof error?.code === "string") return error.code;
  return typeof detail?.code === "string" ? detail.code : null;
}

function xhrError(xhr: XMLHttpRequest, fallback: string): ApiError {
  let detail = fallback;
  let code: string | null = null;
  try {
    const body = JSON.parse(xhr.responseText);
    detail = extractError(body) ?? detail;
    code = errorCode(body);
  } catch {
    /* keep fallback */
  }
  const error = new ApiError(xhr.status, detail);
  if (code) error.code = code;
  return error;
}

export const api = {
  me: () => request<{ email: string; name: string }>("/api/me"),
  brands: () => request<Brand[]>("/api/brands"),
  teamFolders: (brand: string) =>
    request<TeamFolder[]>(`/api/${brand}/teamfolders`),
  children: (brand: string, folderId: string) =>
    request<DriveItem[]>(`/api/${brand}/folders/${folderId}/children`),
  search: (brand: string, q: string) =>
    request<DriveItem[]>(`/api/${brand}/search?q=${encodeURIComponent(q)}`),
  createFolder: (brand: string, parentId: string, name: string) =>
    request<DriveItem>(`/api/${brand}/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_id: parentId, name }),
    }),
  createTeamFolder: (brand: string, name: string) =>
    request<TeamFolder>(`/api/${brand}/teamfolders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  rename: (brand: string, fileId: string, name: string) =>
    request<DriveItem>(`/api/${brand}/files/${fileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  move: (brand: string, fileId: string, parentId: string) =>
    request<DriveItem>(`/api/${brand}/files/${fileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_id: parentId }),
    }),
  trash: (brand: string, fileId: string) =>
    request<{ status: string }>(`/api/${brand}/files/${fileId}`, {
      method: "DELETE",
    }),
  downloadUrl: (brand: string, fileId: string) =>
    `/api/${brand}/files/${fileId}/download`,
  startUpload: (
    brand: string,
    folderId: string,
    body: { filename: string; size: number; content_type: string },
  ) =>
    request<{ upload_id: string; chunk_size: number }>(
      `/api/${brand}/folders/${folderId}/uploads`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  completeUpload: (brand: string, uploadId: string) =>
    request<void>(`/api/${brand}/uploads/${uploadId}/complete`, {
      method: "POST",
    }),
  putChunk: (
    brand: string,
    uploadId: string,
    blob: Blob,
    contentRange: string,
    onProgress: (pct: number) => void,
    signal: AbortSignal,
  ): Promise<{ acked_end: number }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const cleanup = () => signal.removeEventListener("abort", abort);
      xhr.open("PUT", `/api/${brand}/uploads/${uploadId}/chunks`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("Content-Range", contentRange);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress((event.loaded / event.total) * 100);
      };
      xhr.onload = () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const body = JSON.parse(xhr.responseText) as {
              acked_end: number;
            };
            resolve(body);
          } catch {
            reject(new ApiError(xhr.status, "Invalid chunk upload response"));
          }
        } else {
          reject(xhrError(xhr, `Chunk upload failed (${xhr.status})`));
        }
      };
      xhr.onerror = () => {
        cleanup();
        reject(new ApiError(0, "Network error during chunk upload"));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new DOMException("Upload aborted", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      xhr.send(blob);
    }),
  upload: (
    brand: string,
    folderId: string,
    file: File,
    onProgress: (pct: number) => void,
    signal?: AbortSignal,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      const abort = () => xhr.abort();
      const cleanup = () => signal?.removeEventListener("abort", abort);
      form.append("file", file, file.name);
      xhr.open("POST", `/api/${brand}/folders/${folderId}/upload`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
      };
      xhr.onload = () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(xhrError(xhr, `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => {
        cleanup();
        reject(new ApiError(0, "Network error during upload"));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new DOMException("Upload aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      xhr.send(form);
    }),
};

export function makeTransport(brand: string): ChunkTransport {
  return {
    start: (folderId, body) => api.startUpload(brand, folderId, body),
    putChunk: (uploadId, blob, contentRange, onProgress, signal) =>
      api.putChunk(brand, uploadId, blob, contentRange, onProgress, signal),
    complete: (uploadId) => api.completeUpload(brand, uploadId),
    simpleUpload: (folderId, file, onProgress, signal) =>
      api.upload(brand, folderId, file, onProgress, signal),
  };
}
