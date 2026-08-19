import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, makeTransport } from "./api";
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
import {
  CompleteFailedError,
  SessionExpiredError,
  UploadSessionExpiredError,
  uploadFile,
} from "./upload/chunkedUpload";
import { createSerialQueue } from "./upload/queue";

export type View =
  | { kind: "root" }
  | { kind: "folder"; crumbs: Crumb[] }
  | { kind: "search"; q: string };

let toastSeq = 0;
let uploadSeq = 0;

type UploadJob = {
  file: File;
  brand: string;
  folderId: string;
  uploadId?: string;
  completeOnly?: boolean;
};

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
  const uploadQueue = useRef(createSerialQueue()).current;
  const uploadJobs = useRef(new Map<number, UploadJob>());
  const controllers = useRef(new Map<number, AbortController>());
  const pausedIds = useRef(new Set<number>());
  const pauseWaiters = useRef(new Map<number, () => void>());

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
        if (brandsResp.length > 0) {
          const saved = localStorage.getItem("storage.brand");
          const initial =
            brandsResp.find((b) => b.code === saved)?.code ?? brandsResp[0].code;
          setBrand(initial);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
  }, []);

  // Brand switch: reload team folders, reset to root
  useEffect(() => {
    if (!brand) return;
    localStorage.setItem("storage.brand", brand);
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
          members_count: tf.members_count ?? null,
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

  const updateUpload = useCallback((id: number, patch: Partial<Upload>) => {
    setUploads((current) =>
      current.map((upload) =>
        upload.id === id ? { ...upload, ...patch } : upload,
      ),
    );
  }, []);

  const runUpload = useCallback(
    async (id: number) => {
      const job = uploadJobs.current.get(id);
      if (!job) return;

      const controller = new AbortController();
      controllers.current.set(id, controller);
      updateUpload(id, {
        status: "uploading",
        paused: false,
        message: undefined,
      });

      try {
        if (job.completeOnly && job.uploadId) {
          try {
            await api.completeUpload(job.brand, job.uploadId);
          } catch (error) {
            const status = (error as { status?: number } | undefined)?.status;
            if (status !== 404 && status !== 410) throw error;
            job.completeOnly = false;
            job.uploadId = undefined;
            toast("Upload session expired — restarting from the beginning.");
          }
        }

        if (!job.completeOnly) {
          const baseTransport = makeTransport(job.brand);
          let chunkStartAttempted = false;
          const result = await uploadFile({
            brand: job.brand,
            folderId: job.folderId,
            file: job.file,
            transport: {
              ...baseTransport,
              start: async (folderId, body) => {
                chunkStartAttempted = true;
                const session = await baseTransport.start(folderId, body);
                updateUpload(id, { mode: "chunked" });
                return session;
              },
              simpleUpload: async (
                folderId,
                file,
                onProgress,
                signal,
              ) => {
                updateUpload(id, {
                  mode: chunkStartAttempted ? "fallback" : "simple",
                });
                await baseTransport.simpleUpload(
                  folderId,
                  file,
                  onProgress,
                  signal,
                );
              },
            },
            onProgress: (pct) => updateUpload(id, { pct }),
            isPaused: () => pausedIds.current.has(id),
            signal: controller.signal,
            waitWhilePaused: () => {
              if (!pausedIds.current.has(id)) return Promise.resolve();
              return new Promise<void>((resolve) => {
                pauseWaiters.current.set(id, resolve);
              });
            },
          });
          updateUpload(id, { mode: result.mode });
        }

        updateUpload(id, {
          pct: 100,
          status: "done",
          paused: false,
          message: undefined,
        });
        uploadJobs.current.delete(id);
        void loadView();
      } catch (error) {
        if (!uploadJobs.current.has(id)) return;
        if ((error as Error | undefined)?.name === "AbortError") {
          setUploads((current) => current.filter((upload) => upload.id !== id));
          uploadJobs.current.delete(id);
          return;
        }

        let message =
          error instanceof Error ? error.message : "Upload failed.";
        if (error instanceof SessionExpiredError) {
          message =
            "signed out — upload must restart after you sign in.";
          job.completeOnly = false;
          job.uploadId = undefined;
        } else if (error instanceof UploadSessionExpiredError) {
          message =
            "upload session expired — Retry will restart from the beginning.";
          job.completeOnly = false;
          job.uploadId = undefined;
        } else if (error instanceof CompleteFailedError) {
          if (error.cause instanceof UploadSessionExpiredError) {
            message =
              "upload session expired — Retry will restart from the beginning.";
            job.completeOnly = false;
            job.uploadId = undefined;
          } else {
            job.completeOnly = true;
            job.uploadId = error.uploadId;
            message =
              error.cause instanceof SessionExpiredError
                ? "signed out — upload must restart after you sign in."
                : error.message;
          }
        }
        updateUpload(id, { status: "failed", paused: false, message });
        toast(`Upload failed: ${message}`, "error");
      } finally {
        controllers.current.delete(id);
        pausedIds.current.delete(id);
        pauseWaiters.current.delete(id);
      }
    },
    [loadView, toast, updateUpload],
  );

  const doUpload = (files: FileList | File[]) => {
    if (!currentFolderId) {
      toast("Open a folder first to upload files", "error");
      return;
    }
    for (const file of Array.from(files)) {
      const id = ++uploadSeq;
      const upload: Upload = {
        id,
        name: file.name,
        pct: 0,
        status: "queued",
      };
      uploadJobs.current.set(id, {
        file,
        brand,
        folderId: currentFolderId,
      });
      setUploads((u) => [...u, upload]);
      uploadQueue.enqueue(() => runUpload(id));
    }
  };

  const pauseUpload = (id: number) => {
    pausedIds.current.add(id);
    updateUpload(id, { paused: true });
  };

  const resumeUpload = (id: number) => {
    pausedIds.current.delete(id);
    updateUpload(id, { paused: false });
    pauseWaiters.current.get(id)?.();
    pauseWaiters.current.delete(id);
  };

  const retryUpload = (id: number) => {
    if (!uploadJobs.current.has(id)) return;
    updateUpload(id, {
      status: "queued",
      pct: 0,
      paused: false,
      message: undefined,
    });
    uploadQueue.enqueue(() => runUpload(id));
  };

  const cancelUpload = (id: number) => {
    controllers.current.get(id)?.abort();
    pausedIds.current.delete(id);
    pauseWaiters.current.get(id)?.();
    pauseWaiters.current.delete(id);
    uploadJobs.current.delete(id);
    setUploads((current) => current.filter((upload) => upload.id !== id));
  };

  const hasUploading = uploads.some((upload) => upload.status === "uploading");
  const hasPendingUploads = uploads.some(
    (upload) => upload.status === "queued" || upload.status === "uploading",
  );

  useEffect(() => {
    if (!hasUploading) return;
    const interval = window.setInterval(() => {
      void api.me();
    }, 4 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [hasUploading]);

  useEffect(() => {
    if (!hasPendingUploads) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [hasPendingUploads]);

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
        canCreateTeamFolder={view.kind === "root"}
        onNewFolder={() => setModal({ type: "newFolder" })}
        onNewTeamFolder={() => setModal({ type: "newTeamFolder" })}
        onUploadFiles={doUpload}
        onDownload={download}
        onRename={(item) => setModal({ type: "rename", item })}
        onMove={(item) => setModal({ type: "move", item })}
        onDelete={(item) => setModal({ type: "delete", item })}
        onRefresh={() => void loadView()}
        onSearch={(q) => setView({ kind: "search", q })}
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
          setUploads((u) =>
            u.filter(
              (x) => x.status === "queued" || x.status === "uploading",
            ),
          )
        }
        onPause={pauseUpload}
        onResume={resumeUpload}
        onRetry={retryUpload}
        onCancel={cancelUpload}
      />
    </div>
  );
}
