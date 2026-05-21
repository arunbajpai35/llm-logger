"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Convo = {
  id: string;
  title: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  _count: { messages: number };
};

const STATUS_STYLES: Record<string, string> = {
  active: "bg-[rgba(74,222,128,0.1)] text-[var(--success)] border-[rgba(74,222,128,0.2)]",
  completed: "bg-[rgba(124,92,255,0.1)] text-[var(--accent)] border-[rgba(124,92,255,0.2)]",
  cancelled: "bg-[rgba(248,113,113,0.1)] text-[var(--danger)] border-[rgba(248,113,113,0.2)]",
};

export default function ConversationsPage() {
  const [convos, setConvos] = useState<Convo[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "active" | "cancelled">("all");

  async function load() {
    setLoading(true);
    const res = await fetch("/api/conversations");
    setConvos(await res.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function cancel(id: string) {
    await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    load();
  }

  async function remove(id: string) {
    if (!confirm("Delete this conversation? Inference logs will be retained.")) return;
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    load();
  }

  const filtered = convos.filter((c) => filter === "all" || c.status === filter);

  return (
    <div>
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Conversations</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            {convos.length} total · {convos.filter((c) => c.status === "active").length} active
          </p>
        </div>
        <div className="flex gap-1 p-1 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)]">
          {(["all", "active", "cancelled"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={
                "px-3 py-1 text-xs rounded-md transition-colors capitalize " +
                (filter === f
                  ? "bg-[var(--bg-hover)] text-[var(--text)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]")
              }
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 rounded-xl shimmer bg-[var(--bg-elevated)]" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 glass rounded-2xl">
          <p className="text-[var(--text-muted)] text-sm">No conversations {filter !== "all" && `(${filter})`} yet.</p>
          <Link href="/" className="inline-block mt-3 text-sm text-[var(--accent)] hover:underline">
            Start a new chat →
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => (
            <div
              key={c.id}
              className="group glass rounded-xl px-4 py-3 hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] transition-all flex items-center gap-4"
            >
              <Link href={`/?id=${c.id}`} className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium truncate">{c.title ?? "(untitled)"}</span>
                  <span
                    className={
                      "text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border " +
                      (STATUS_STYLES[c.status] ?? STATUS_STYLES.active)
                    }
                  >
                    {c.status}
                  </span>
                </div>
                <div className="text-xs text-[var(--text-muted)] flex items-center gap-2 font-mono-num">
                  <span>{c._count.messages} msgs</span>
                  <span className="text-[var(--text-faint)]">·</span>
                  <span>{timeAgo(c.updatedAt)}</span>
                </div>
              </Link>
              <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                <Link
                  href={`/?id=${c.id}`}
                  className="px-3 py-1.5 text-xs rounded-md hover:bg-[var(--bg-elevated)] text-[var(--text)]"
                >
                  Resume
                </Link>
                {c.status !== "cancelled" && (
                  <button
                    onClick={() => cancel(c.id)}
                    className="px-3 py-1.5 text-xs rounded-md hover:bg-[rgba(251,191,36,0.1)] text-[var(--warn)]"
                  >
                    Cancel
                  </button>
                )}
                <button
                  onClick={() => remove(c.id)}
                  className="px-3 py-1.5 text-xs rounded-md hover:bg-[rgba(248,113,113,0.1)] text-[var(--danger)]"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
