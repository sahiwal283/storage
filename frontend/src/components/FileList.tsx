import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderClosed,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import type { DriveItem, SortKey, SortOrder } from "../types";
import type { View } from "../App";
import { createdBySubtitle, formatBytes, formatDate } from "../format";

interface Props {
  view: View;
  brandName: string;
  items: DriveItem[];
  loading: boolean;
  error: string | null;
  sortKey: SortKey;
  sortOrder: SortOrder;
  onSort: (key: SortKey) => void;
  selected: DriveItem | null;
  onSelect: (item: DriveItem | null) => void;
  onOpen: (item: DriveItem) => void;
  onCrumb: (index: number) => void;
  canMutate: boolean;
  canCreateTeamFolder: boolean;
  onNewFolder: () => void;
  onNewTeamFolder: () => void;
  onUploadFiles: (files: FileList | File[]) => void;
  onDownload: (item: DriveItem) => void;
  onRename: (item: DriveItem) => void;
  onMove: (item: DriveItem) => void;
  onDelete: (item: DriveItem) => void;
  onRefresh: () => void;
  onSearch?: (q: string) => void;
}

interface MenuState {
  x: number;
  y: number;
  item: DriveItem;
}

export function FileList(props: Props) {
  const {
    view,
    brandName,
    items,
    loading,
    error,
    sortKey,
    sortOrder,
    onSort,
    selected,
    onSelect,
    onOpen,
    onCrumb,
    canMutate,
    canCreateTeamFolder,
    onUploadFiles,
    onRefresh,
  } = props;

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    const close = () => setMenu(null);
    document.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, []);

  useEffect(() => {
    if (!newMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!newMenuRef.current?.contains(e.target as Node)) setNewMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [newMenuOpen]);

  const sortIcon = (key: SortKey) =>
    sortKey === key ? (
      sortOrder === "asc" ? (
        <ArrowUp size={13} />
      ) : (
        <ArrowDown size={13} />
      )
    ) : null;

  return (
    <main
      className="main"
      style={{ position: "relative" }}
      onDragEnter={(e) => {
        e.preventDefault();
        if (canMutate && e.dataTransfer.types.includes("Files")) {
          dragDepth.current += 1;
          setDragOver(true);
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        if (dragDepth.current > 0) dragDepth.current -= 1;
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        if (canMutate && e.dataTransfer.files.length > 0)
          onUploadFiles(e.dataTransfer.files);
      }}
    >
      {dragOver && <div className="drop-overlay">Drop files to upload</div>}
      {error && /oauth|credential|scope|team_id|not configured/i.test(error) && (
        <div className="banner">
          This company is not connected to WorkDrive yet. An admin needs to
          re-consent WorkDrive scopes for this brand in the Zoho integration
          admin, then retry.
        </div>
      )}

      <div className="main-header">
        {view.kind === "search" ? (
          <h1>
            <Search size={17} /> Results for “{view.q}”
          </h1>
        ) : view.kind === "root" ? (
          <h1>
            <Folder size={17} /> Team Folders
            <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
              · {brandName}
            </span>
          </h1>
        ) : (
          <div className="breadcrumbs">
            <button className="crumb" onClick={() => onCrumb(-1)}>
              Team Folders
            </button>
            {view.crumbs.map((c, i) => (
              <span key={c.id} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <ChevronRight className="crumb-sep" size={14} />
                {i === view.crumbs.length - 1 ? (
                  <span className="crumb current">{c.name}</span>
                ) : (
                  <button className="crumb" onClick={() => onCrumb(i)}>
                    {c.name}
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="toolbar">
        <div className="main-search">
          <Search size={15} />
          <input
            placeholder="Search"
            defaultValue={view.kind === "search" ? view.q : ""}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const q = (e.target as HTMLInputElement).value.trim();
                if (q) props.onSearch?.(q);
              }
            }}
          />
        </div>
        <span className="spacer" />
        {canMutate || canCreateTeamFolder ? (
          <div ref={newMenuRef} style={{ position: "relative" }}>
            <button className="btn primary" onClick={() => setNewMenuOpen((o) => !o)}>
              <Plus size={15} /> New
            </button>
            {newMenuOpen && (
              <div
                className="context-menu"
                style={{ position: "absolute", top: "calc(100% + 6px)", right: 0 }}
              >
                {canCreateTeamFolder ? (
                  <button
                    onClick={() => {
                      setNewMenuOpen(false);
                      props.onNewTeamFolder();
                    }}
                  >
                    <FolderPlus size={15} /> New Team Folder
                  </button>
                ) : null}
                {canMutate ? (
                  <>
                    <button
                      onClick={() => {
                        setNewMenuOpen(false);
                        fileInput.current?.click();
                      }}
                    >
                      <Upload size={15} /> Upload files
                    </button>
                    <button
                      onClick={() => {
                        setNewMenuOpen(false);
                        props.onNewFolder();
                      }}
                    >
                      <FolderPlus size={15} /> New folder
                    </button>
                  </>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onUploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div className="file-table" onClick={() => onSelect(null)}>
        {view.kind !== "root" && (
          <div className="table-head">
            <button onClick={() => onSort("name")}>Name {sortIcon("name")}</button>
            <button onClick={() => onSort("modified_time")}>
              Last Modified {sortIcon("modified_time")}
            </button>
            <button onClick={() => onSort("size")}>Size {sortIcon("size")}</button>
            <span />
          </div>
        )}

        {loading ? (
          <div className="empty-state">
            <span className="spinner" />
          </div>
        ) : error ? (
          <div className="empty-state">
            <span>{error}</span>
            <button className="btn" onClick={onRefresh}>
              Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <FolderClosed size={40} strokeWidth={1.2} />
            <span>
              {view.kind === "search" ? "No results" : "This folder is empty"}
            </span>
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className={`row ${view.kind === "root" ? "root-row" : ""} ${selected?.id === item.id ? "selected" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(item);
              }}
              onDoubleClick={() => onOpen(item)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSelect(item);
                setMenu({ x: e.clientX, y: e.clientY, item });
              }}
            >
              <div className="name-cell">
                {item.type === "folder" ? (
                  <Folder className="folder-icon" size={22} />
                ) : (
                  <FileText className="file-icon" size={22} />
                )}
                <div className="texts">
                  <div className="name">{item.name}</div>
                  {view.kind !== "root" && createdBySubtitle(item) && (
                    <div
                      className="subtitle"
                      title={item.created_by_email || undefined}
                    >
                      {createdBySubtitle(item)}
                    </div>
                  )}
                </div>
              </div>
              {view.kind === "root" ? (
                <div className="member-meta">
                  {item.members_count != null
                    ? `${item.members_count} Member${item.members_count === 1 ? "" : "s"}`
                    : "Team Folder"}
                </div>
              ) : (
                <>
                  <div className="meta">
                    {item.modified_time
                      ? `${formatDate(item.modified_time)}${
                          item.modified_by ? ` by ${item.modified_by}` : ""
                        }`
                      : "—"}
                  </div>
                  <div className="meta">
                    {item.type === "folder" ? "—" : formatBytes(item.size)}
                  </div>
                </>
              )}
              <div className="actions">
                <button
                  className="icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(item);
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMenu({ x: rect.left, y: rect.bottom + 4, item });
                  }}
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {menu && (
        <ItemMenu menu={menu} onClose={() => setMenu(null)} {...props} />
      )}
    </main>
  );
}

function ItemMenu({
  menu,
  canMutate,
  onClose,
  onOpen,
  onDownload,
  onRename,
  onMove,
  onDelete,
}: Props & { menu: MenuState; onClose: () => void }) {
  const { item } = menu;
  const style = {
    left: Math.min(menu.x, window.innerWidth - 200),
    top: Math.min(menu.y, window.innerHeight - 220),
  };
  const act = (fn: (i: DriveItem) => void) => () => {
    onClose();
    fn(item);
  };
  return (
    <div className="context-menu" style={style} onClick={(e) => e.stopPropagation()}>
      {item.type === "folder" ? (
        <button onClick={act(onOpen)}>
          <Folder size={15} /> Open
        </button>
      ) : (
        <button onClick={act(onDownload)}>
          <Download size={15} /> Download
        </button>
      )}
      {canMutate && (
        <>
          <div className="divider" />
          <button onClick={act(onRename)}>
            <Pencil size={15} /> Rename
          </button>
          <button onClick={act(onMove)}>
            <FolderInput size={15} /> Move
          </button>
          <div className="divider" />
          <button className="danger" onClick={act(onDelete)}>
            <Trash2 size={15} /> Delete
          </button>
        </>
      )}
    </div>
  );
}
