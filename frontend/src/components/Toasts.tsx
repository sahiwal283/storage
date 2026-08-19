import { AlertCircle, CheckCircle2 } from "lucide-react";

export interface Toast {
  id: number;
  msg: string;
  kind: "info" | "error";
}

export function Toasts({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>
          {t.kind === "error" ? (
            <AlertCircle size={16} color="var(--danger)" />
          ) : (
            <CheckCircle2 size={16} color="var(--accent)" />
          )}
          <span className="msg">{t.msg}</span>
        </div>
      ))}
    </div>
  );
}
