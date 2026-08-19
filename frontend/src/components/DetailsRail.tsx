import { FileText, Folder, Info } from "lucide-react";
import type { DriveItem } from "../types";
import type { View } from "../App";
import { formatBytes, formatDate } from "../format";

interface Props {
  open: boolean;
  onToggle: () => void;
  item: DriveItem | null;
  view: View;
  brandName: string;
}

export function DetailsRail({ open, onToggle, item, view, brandName }: Props) {
  return (
    <aside className="rail">
      {open && (
        <div className="details-panel">
          <h2>Details</h2>
          {item ? (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 16,
                }}
              >
                {item.type === "folder" ? (
                  <Folder className="folder-icon" size={28} />
                ) : (
                  <FileText className="file-icon" size={28} />
                )}
                <strong style={{ wordBreak: "break-word" }}>{item.name}</strong>
              </div>
              <Entry label="Type" value={item.type === "folder" ? "Folder" : item.extension?.toUpperCase() || "File"} />
              {item.type === "file" && (
                <Entry label="Size" value={formatBytes(item.size)} />
              )}
              <Entry label="Company" value={brandName} />
              <Entry
                label="Modified"
                value={
                  item.modified_time
                    ? `${formatDate(item.modified_time)}${
                        item.modified_by ? ` by ${item.modified_by}` : ""
                      }`
                    : "—"
                }
              />
              <Entry
                label="Created"
                value={
                  item.created_time
                    ? `${formatDate(item.created_time)}${
                        item.created_by ? ` by ${item.created_by}` : ""
                      }`
                    : "—"
                }
              />
            </>
          ) : (
            <div style={{ color: "var(--text-muted)" }}>
              {view.kind === "root"
                ? `${brandName} team folders`
                : "Select a file or folder to see its details"}
            </div>
          )}
        </div>
      )}
      <div className="rail-tabs">
        <button
          className={`rail-tab ${open ? "active" : ""}`}
          onClick={onToggle}
          title="Details"
        >
          <Info size={18} />
          <span>Details</span>
        </button>
      </div>
    </aside>
  );
}

function Entry({ label, value }: { label: string; value: string }) {
  return (
    <div className="details-entry">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
