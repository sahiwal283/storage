import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderClosed,
  Users,
} from "lucide-react";
import type { Brand, TeamFolder } from "../types";
import { brandColor, initials } from "../format";

interface Props {
  brands: Brand[];
  brand: Brand | null;
  onBrandChange: (code: string) => void;
  teamFolders: TeamFolder[];
  activeTeamFolderId: string | null;
  rootActive: boolean;
  onRoot: () => void;
  onOpenTeamFolder: (tf: TeamFolder) => void;
}

export function Sidebar({
  brands,
  brand,
  onBrandChange,
  teamFolders,
  activeTeamFolderId,
  rootActive,
  onRoot,
  onOpenTeamFolder,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [pickerOpen]);

  return (
    <nav className="sidebar">
      <div className="brand-picker" ref={pickerRef}>
        <button
          className="brand-picker-btn"
          onClick={() => setPickerOpen((o) => !o)}
        >
          {brand && (
            <span
              className="brand-badge"
              style={{ background: brandColor(brand.code) }}
            >
              {initials(brand.name)}
            </span>
          )}
          <span className="brand-picker-name">{brand?.name ?? "Loading…"}</span>
          <ChevronDown size={15} />
        </button>
        {pickerOpen && (
          <div className="brand-menu">
            {brands.map((b) => (
              <button
                key={b.code}
                onClick={() => {
                  setPickerOpen(false);
                  if (b.code !== brand?.code) onBrandChange(b.code);
                }}
              >
                <span
                  className="brand-badge"
                  style={{ background: brandColor(b.code) }}
                >
                  {initials(b.name)}
                </span>
                <span>{b.name}</span>
                {b.code === brand?.code && <Check className="check" size={15} />}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="nav-section">
        <button
          className={`nav-item ${rootActive ? "active" : ""}`}
          style={{ paddingLeft: 16 }}
          onClick={onRoot}
        >
          <Users size={16} />
          <span style={{ fontWeight: 600 }}>Team Folders</span>
        </button>
        <button className="nav-heading" onClick={() => setExpanded((e) => !e)}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span style={{ fontSize: 12 }}>
            {brand ? `${brand.name.toUpperCase()}` : ""}
          </span>
        </button>
        {expanded &&
          teamFolders.map((tf) => (
            <button
              key={tf.id}
              className={`nav-item ${
                tf.id === activeTeamFolderId ? "active" : ""
              }`}
              onClick={() => onOpenTeamFolder(tf)}
              title={tf.name}
            >
              <FolderClosed size={15} />
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {tf.name}
              </span>
            </button>
          ))}
        {expanded && teamFolders.length === 0 && (
          <div
            className="nav-item"
            style={{ color: "var(--text-muted)", cursor: "default" }}
          >
            No team folders
          </div>
        )}
      </div>
    </nav>
  );
}
