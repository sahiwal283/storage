import type { Brand, DriveItem, TeamFolder } from "./types";

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, init);
  if (resp.status === 401) {
    window.location.href = "/auth/login";
    throw new ApiError(401, "Not authenticated");
  }
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = await resp.json();
      detail = extractError(body) ?? detail;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(resp.status, detail);
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
  upload: (
    brand: string,
    folderId: string,
    file: File,
    onProgress: (pct: number) => void
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append("file", file, file.name);
      xhr.open("POST", `/api/${brand}/folders/${folderId}/upload`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          let detail = `Upload failed (${xhr.status})`;
          try {
            const body = JSON.parse(xhr.responseText);
            if (typeof body.detail === "string") detail = body.detail;
          } catch {
            /* default message */
          }
          reject(new ApiError(xhr.status, detail));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, "Network error during upload"));
      xhr.send(form);
    }),
};
