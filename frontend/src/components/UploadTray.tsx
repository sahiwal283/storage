import { X } from "lucide-react";

export interface Upload {
  name: string;
  pct: number;
  status: "uploading" | "done" | "failed";
}

export function UploadTray({
  uploads,
  onClear,
}: {
  uploads: Upload[];
  onClear: () => void;
}) {
  if (uploads.length === 0) return null;
  const active = uploads.filter((u) => u.status === "uploading").length;
  return (
    <div className="upload-tray">
      <div className="tray-head">
        <span>
          {active > 0
            ? `Uploading ${active} item${active > 1 ? "s" : ""}…`
            : "Uploads complete"}
        </span>
        {active === 0 && (
          <button className="icon-btn" onClick={onClear} title="Dismiss">
            <X size={15} />
          </button>
        )}
      </div>
      {uploads.map((u, i) => (
        <div className="tray-item" key={i}>
          <span className="fname">
            {u.name}
            {u.status === "failed" && (
              <span style={{ color: "var(--danger)" }}> — failed</span>
            )}
          </span>
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
        </div>
      ))}
    </div>
  );
}
