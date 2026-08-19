import { X } from "lucide-react";

export interface Upload {
  id: number;
  name: string;
  pct: number;
  status: "queued" | "uploading" | "done" | "failed";
  mode?: "chunked" | "simple" | "fallback";
  paused?: boolean;
  message?: string;
}

export function UploadTray({
  uploads,
  onClear,
  onPause,
  onResume,
  onRetry,
  onCancel,
}: {
  uploads: Upload[];
  onClear: () => void;
  onPause: (id: number) => void;
  onResume: (id: number) => void;
  onRetry: (id: number) => void;
  onCancel: (id: number) => void;
}) {
  if (uploads.length === 0) return null;
  const active = uploads.filter((u) => u.status === "uploading").length;
  const queued = uploads.filter((u) => u.status === "queued").length;
  return (
    <div className="upload-tray">
      <div className="tray-head">
        <span>
          {active > 0
            ? `Uploading ${active} item${active > 1 ? "s" : ""}…`
            : queued > 0
              ? `${queued} item${queued > 1 ? "s" : ""} queued`
            : "Uploads complete"}
        </span>
        {active === 0 && queued === 0 && (
          <button className="icon-btn" onClick={onClear} title="Dismiss">
            <X size={15} />
          </button>
        )}
      </div>
      {uploads.map((u) => (
        <div className="tray-item" key={u.id}>
          <div className="tray-item-head">
            <span className="fname">
              {u.name}
              {u.status === "queued" && (
                <span className="upload-state"> — queued</span>
              )}
              {u.status === "failed" && (
                <span className="upload-state failed"> — failed</span>
              )}
            </span>
            <div className="tray-actions">
              {u.status === "uploading" &&
                u.mode === "chunked" &&
                (u.paused ? (
                  <button onClick={() => onResume(u.id)}>Resume</button>
                ) : (
                  <button onClick={() => onPause(u.id)}>Pause</button>
                ))}
              {u.status === "failed" && (
                <button onClick={() => onRetry(u.id)}>Retry</button>
              )}
              {(u.status === "queued" || u.status === "uploading") && (
                <button onClick={() => onCancel(u.id)}>Cancel</button>
              )}
            </div>
          </div>
          <div className="progress">
            <div
              className="bar"
              style={{
                width: `${u.pct}%`,
                background:
                  u.status === "failed" ? "var(--danger)" : undefined,
              }}
            />
          </div>
          {u.message && <span className="upload-message">{u.message}</span>}
        </div>
      ))}
    </div>
  );
}
