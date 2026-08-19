import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { api } from "../api";
import type { DriveItem, TeamFolder } from "../types";

export type ModalState =
  | null
  | { type: "newFolder" }
  | { type: "rename"; item: DriveItem }
  | { type: "move"; item: DriveItem }
  | { type: "delete"; item: DriveItem };

interface Props {
  modal: ModalState;
  onClose: () => void;
  brand: string;
  currentFolderId: string | null;
  teamFolders: TeamFolder[];
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}

export function Modals(props: Props) {
  const { modal } = props;
  if (!modal) return null;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      {modal.type === "newFolder" && <NewFolder {...props} />}
      {modal.type === "rename" && <Rename {...props} item={modal.item} />}
      {modal.type === "move" && <Move {...props} item={modal.item} />}
      {modal.type === "delete" && <Delete {...props} item={modal.item} />}
    </div>
  );
}

function NewFolder({ brand, currentFolderId, onClose, onDone, onError }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || !currentFolderId || busy) return;
    setBusy(true);
    try {
      await api.createFolder(brand, currentFolderId, name.trim());
      onDone(`Folder “${name.trim()}” created`);
    } catch (e) {
      setBusy(false);
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="modal">
      <h2>New folder</h2>
      <div className="field">
        <input
          autoFocus
          placeholder="Folder name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
      </div>
      <div className="actions-row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!name.trim() || busy}
          onClick={() => void submit()}
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </div>
  );
}

function Rename({
  brand,
  item,
  onClose,
  onDone,
  onError,
}: Props & { item: DriveItem }) {
  const [name, setName] = useState(item.name);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const next = name.trim();
    if (!next || next === item.name || busy) return;
    setBusy(true);
    try {
      await api.rename(brand, item.id, next);
      onDone(`Renamed to “${next}”`);
    } catch (e) {
      setBusy(false);
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="modal">
      <h2>Rename</h2>
      <div className="field">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          onFocus={(e) => {
            const dot = item.name.lastIndexOf(".");
            e.target.setSelectionRange(0, dot > 0 ? dot : item.name.length);
          }}
        />
      </div>
      <div className="actions-row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!name.trim() || name.trim() === item.name || busy}
          onClick={() => void submit()}
        >
          {busy ? "Renaming…" : "Rename"}
        </button>
      </div>
    </div>
  );
}

function Delete({
  brand,
  item,
  onClose,
  onDone,
  onError,
}: Props & { item: DriveItem }) {
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.trash(brand, item.id);
      onDone(`“${item.name}” moved to WorkDrive trash`);
    } catch (e) {
      setBusy(false);
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="modal">
      <h2>Delete {item.type === "folder" ? "folder" : "file"}?</h2>
      <p style={{ color: "var(--text-secondary)" }}>
        “{item.name}” will be moved to the WorkDrive trash. It can be restored
        from Zoho WorkDrive.
      </p>
      <div className="actions-row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn danger" disabled={busy} onClick={() => void submit()}>
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  );
}

interface TreeNode {
  id: string;
  name: string;
  children: TreeNode[] | null; // null = not loaded yet
  expanded: boolean;
}

function Move({
  brand,
  item,
  teamFolders,
  onClose,
  onDone,
  onError,
}: Props & { item: DriveItem }) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTree(
      teamFolders.map((tf) => ({
        id: tf.id,
        name: tf.name,
        children: null,
        expanded: false,
      }))
    );
  }, [teamFolders]);

  const toggle = async (node: TreeNode) => {
    if (node.expanded) {
      update(node.id, { expanded: false });
      return;
    }
    if (node.children === null) {
      try {
        const kids = await api.children(brand, node.id);
        update(node.id, {
          expanded: true,
          children: kids
            .filter((k) => k.type === "folder" && k.id !== item.id)
            .map((k) => ({
              id: k.id,
              name: k.name,
              children: null,
              expanded: false,
            })),
        });
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      }
    } else {
      update(node.id, { expanded: true });
    }
  };

  const update = (id: string, patch: Partial<TreeNode>) => {
    const walk = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((n) =>
        n.id === id
          ? { ...n, ...patch }
          : n.children
          ? { ...n, children: walk(n.children) }
          : n
      );
    setTree(walk);
  };

  const submit = async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      await api.move(brand, item.id, target.id);
      onDone(`Moved “${item.name}” to “${target.name}”`);
    } catch (e) {
      setBusy(false);
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((n) => (
      <div key={n.id}>
        <button
          className={`tree-item ${target?.id === n.id ? "selected" : ""}`}
          style={{ paddingLeft: 8 + depth * 18 }}
          onClick={() => setTarget({ id: n.id, name: n.name })}
        >
          <span
            onClick={(e) => {
              e.stopPropagation();
              void toggle(n);
            }}
            style={{ display: "inline-flex" }}
          >
            {n.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <Folder size={14} className="folder-icon" />
          <span
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {n.name}
          </span>
        </button>
        {n.expanded && n.children && renderNodes(n.children, depth + 1)}
      </div>
    ));

  return (
    <div className="modal">
      <h2>Move “{item.name}”</h2>
      <div className="folder-tree">{renderNodes(tree, 0)}</div>
      <div className="actions-row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!target || busy}
          onClick={() => void submit()}
        >
          {busy ? "Moving…" : target ? `Move to “${target.name}”` : "Move"}
        </button>
      </div>
    </div>
  );
}
