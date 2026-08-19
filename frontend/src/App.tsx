import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type {
  Brand,
  Crumb,
  DriveItem,
  SortKey,
  SortOrder,
  TeamFolder,
} from "./types";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { FileList } from "./components/FileList";
import { DetailsRail } from "./components/DetailsRail";
import { Modals, type ModalState } from "./components/Modals";
import { Toasts, type Toast } from "./components/Toasts";
import { UploadTray, type Upload } from "./components/UploadTray";

export type View =
  | { kind: "root" }
  | { kind: "folder"; crumbs: Crumb[] }
  | { kind: "search"; q: string };

let toastSeq = 0;

export default function App() {
  const [me, setMe] = useState<{ name: string; email: string } | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [brand, setBrand] = useState<string>("");
  const [teamFolders, setTeamFolders] = useState<TeamFolder[]>([]);
  const [view, setView] = useState<View>({ kind: "root" });
  const [items, setItems] = useState<DriveItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [selected, setSelected] = useState<DriveItem | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const refreshSeq = useRef(0);

  const toast = useCallback((msg: string, kind: "info" | "error" = "info") => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  // Bootstrap: user + brands
  useEffect(() => {
    (async () => {
      try {
        const [meResp, brandsResp] = await Promise.all([api.me(), api.brands()]);
        setMe(meResp);
        setBrands(brandsResp);
        if (brandsResp.length > 0) setBrand(brandsResp[0].code);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
  }, []);

  // Brand switch: reload team folders, reset to root
  useEffect(() => {
    if (!brand) return;
    setView({ kind: "root" });
    setSelected(null);
    setTeamFolders([]);
    (async () => {
      try {
        setTeamFolders(await api.teamFolders(brand));
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "error");
      }
    })();
  }, [brand, toast]);

  const loadView = useCallback(async () => {
    if (!brand) return;
    const seq = ++refreshSeq.current;
    setLoading(true);
    setError(null);
    try {
      let result: DriveItem[];
      if (view.kind === "root") {
        const tfs = await api.teamFolders(brand);
        if (seq !== refreshSeq.current) return;
        setTeamFolders(tfs);
        result = tfs.map((tf) => ({
          id: tf.id,
          name: tf.name,
          type: "folder" as const,
          size: null,
          extension: null,
          modified_time: null,
          modified_by: null,
          created_time: null,
          created_by: null,
        }));
      } else if (view.kind === "folder") {
        const folderId = view.crumbs[view.crumbs.length - 1].id;
        result = await api.children(brand, folderId);
      } else {
        result = await api.search(brand, view.q);
      }
      if (seq !== refreshSeq.current) return;
      setItems(result);
    } catch (e) {
      if (seq !== refreshSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      if (seq === refreshSeq.current) setLoading(false);
    }
  }, [brand, view]);

  useEffect(() => {
    setSelected(null);
    void loadView();
  }, [loadView]);

  const sortedItems = useMemo(() => {
    const dir = sortOrder === "asc" ? 1 : -1;
    return [...items].sort((a, b) => {
      // Folders always group before files, like WorkDrive
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      if (sortKey === "name") return dir * a.name.localeCompare(b.name);
      if (sortKey === "size") return dir * ((a.size ?? -1) - (b.size ?? -1));
      return (
        dir *
        (Date.parse(a.modified_time ?? "") || 0) -
        dir * (Date.parse(b.modified_time ?? "") || 0)
      );
    });
  }, [items, sortKey, sortOrder]);

  const openFolder = (item: { id: string; name: string }, fromRoot = false) => {
    setView((v) => {
      const base = fromRoot || v.kind !== "folder" ? [] : v.crumbs;
      return { kind: "folder", crumbs: [...base, { id: item.id, name: item.name }] };
    });
  };

  const currentFolderId =
    view.kind === "folder" ? view.crumbs[view.crumbs.length - 1].id : null;

  const doUpload = (files: FileList | File[]) => {
    if (!currentFolderId) {
      toast("Open a folder first to upload files", "error");
      return;
    }
    for (const file of Array.from(files)) {
      const upload: Upload = { name: file.name, pct: 0, status: "uploading" };
      setUploads((u) => [...u, upload]);
      api
        .upload(brand, currentFolderId, file, (pct) => {
          setUploads((u) =>
            u.map((x) => (x === upload ? { ...x, pct } : x))
          );
        })
        .then(() => {
          setUploads((u) =>
            u.map((x) => (x === upload ? { ...x, pct: 100, status: "done" } : x))
          );
          void loadView();
        })
        .catch((e) => {
          setUploads((u) =>
            u.map((x) => (x === upload ? { ...x, status: "failed" } : x))
          );
          toast(`Upload failed: ${e.message}`, "error");
        });
    }
  };

  const download = (item: DriveItem) => {
    const a = document.createElement("a");
    a.href = api.downloadUrl(brand, item.id);
    a.download = item.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  if (error && !me) {
    return (
      <div className="centered">
        <span>{error}</span>
        <button className="btn" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  const brandObj = brands.find((b) => b.code === brand) ?? null;

  return (
    <div className="app">
      <TopBar
        me={me}
        brand={brandObj}
        onSearch={(q) =>
          q.trim()
            ? setView({ kind: "search", q: q.trim() })
            : setView({ kind: "root" })
        }
        searchActive={view.kind === "search"}
      />
      <Sidebar
        brands={brands}
        brand={brandObj}
        onBrandChange={(code) => setBrand(code)}
        teamFolders={teamFolders}
        activeTeamFolderId={
          view.kind === "folder" ? view.crumbs[0]?.id ?? null : null
        }
        rootActive={view.kind === "root"}
        onRoot={() => setView({ kind: "root" })}
        onOpenTeamFolder={(tf) => openFolder(tf, true)}
      />
      <FileList
        view={view}
        brandName={brandObj?.name ?? ""}
        items={sortedItems}
        loading={loading}
        error={error}
        sortKey={sortKey}
        sortOrder={sortOrder}
        onSort={(key) => {
          if (key === sortKey) {
            setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
          } else {
            setSortKey(key);
            setSortOrder("asc");
          }
        }}
        selected={selected}
        onSelect={setSelected}
        onOpen={(item) =>
          item.type === "folder" ? openFolder(item) : download(item)
        }
        onCrumb={(index) =>
          setView((v) =>
            v.kind === "folder"
              ? index < 0
                ? { kind: "root" }
                : { kind: "folder", crumbs: v.crumbs.slice(0, index + 1) }
              : v
          )
        }
        canMutate={view.kind === "folder"}
        onNewFolder={() => setModal({ type: "newFolder" })}
        onUploadFiles={doUpload}
        onDownload={download}
        onRename={(item) => setModal({ type: "rename", item })}
        onMove={(item) => setModal({ type: "move", item })}
        onDelete={(item) => setModal({ type: "delete", item })}
        onRefresh={() => void loadView()}
      />
      <DetailsRail
        open={detailsOpen}
        onToggle={() => setDetailsOpen((o) => !o)}
        item={selected}
        view={view}
        brandName={brandObj?.name ?? ""}
      />
      <Modals
        modal={modal}
        onClose={() => setModal(null)}
        brand={brand}
        currentFolderId={currentFolderId}
        teamFolders={teamFolders}
        onDone={(msg) => {
          setModal(null);
          toast(msg);
          void loadView();
        }}
        onError={(msg) => toast(msg, "error")}
      />
      <Toasts toasts={toasts} />
      <UploadTray
        uploads={uploads}
        onClear={() =>
          setUploads((u) => u.filter((x) => x.status === "uploading"))
        }
      />
    </div>
  );
}
