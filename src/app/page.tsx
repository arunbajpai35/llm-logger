"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "Explain prompt caching in one paragraph",
  "Write a SQL query for the top 5 slowest p95 hours",
  "Draft release notes for an observability tool",
  "Compare Postgres vs Clickhouse for log analytics",
];

export default function Page() {
  return (
    <Suspense fallback={<p className="text-sm text-[var(--text-muted)]">Loading…</p>}>
      <ChatPage />
    </Suspense>
  );
}

function ChatPage() {
  const router = useRouter();
  const params = useSearchParams();
  // Lock initialId to mount-time. Recomputing it from params would re-fire the
  // load effect after router.replace(?id=…), racing the in-flight stream.
  const [initialId] = useState(() => params.get("id") ?? undefined);

  const [conversationId, setConversationId] = useState<string | undefined>(initialId);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);
  const [provider, setProvider] = useState<string>("openai");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/providers")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data?.providers) && data.providers.length > 0) {
          setProviders(data.providers);
          if (!data.providers.includes(provider)) setProvider(data.providers[0]);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!initialId) return;
    fetch(`/api/conversations/${initialId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.messages) {
          setMessages(data.messages.map((m: any) => ({ role: m.role, content: m.content })));
        }
      });
  }, [initialId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const t = textareaRef.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 200) + "px";
  }, [input]);

  async function send(prompt?: string) {
    const text = (prompt ?? input).trim();
    if (!text || streaming) return;
    const userMsg: Msg = { role: "user", content: text };
    setMessages((m) => [...m, userMsg, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, message: userMsg.content, provider }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        setMessages((m) => {
          const next = [...m];
          next[next.length - 1] = { role: "assistant", content: `⚠ Request failed (${res.status})` };
          return next;
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let seenMeta = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        if (!seenMeta) {
          const nl = buffer.indexOf("\n");
          if (nl >= 0) {
            try {
              const meta = JSON.parse(buffer.slice(0, nl));
              if (meta?.conversationId) {
                setConversationId(meta.conversationId);
                if (!initialId) router.replace(`/?id=${meta.conversationId}`);
              }
            } catch {}
            buffer = buffer.slice(nl + 1);
            seenMeta = true;
          }
        }
        if (seenMeta && buffer) {
          const chunk = buffer;
          buffer = "";
          setMessages((m) => {
            const next = [...m];
            next[next.length - 1] = {
              role: "assistant",
              content: next[next.length - 1].content + chunk,
            };
            return next;
          });
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") console.error(err);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function cancelConversation() {
    if (!conversationId) return;
    abortRef.current?.abort();
    await fetch(`/api/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    router.push("/conversations");
  }

  function newChat() {
    router.push("/");
    setConversationId(undefined);
    setMessages([]);
    setInput("");
    textareaRef.current?.focus();
  }

  const empty = messages.length === 0;

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Chat</h1>
          {conversationId && (
            <span className="text-xs text-[var(--text-faint)] font-mono">
              {conversationId.slice(0, 8)}
            </span>
          )}
          {streaming && (
            <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
              streaming
            </span>
          )}
        </div>
        <div className="flex gap-2 items-center">
          {providers.length > 1 && (
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              disabled={streaming}
              className="text-xs rounded-md px-2 py-1.5 bg-[var(--bg-hover)] border border-[var(--border)] outline-none disabled:opacity-60"
              aria-label="Provider"
            >
              {providers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
          {conversationId && (
            <button
              onClick={cancelConversation}
              className="px-3 py-1.5 text-xs rounded-md text-[var(--danger)] hover:bg-[rgba(248,113,113,0.1)] transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            onClick={newChat}
            className="btn-ghost px-3 py-1.5 text-xs rounded-md"
          >
            + New chat
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto glass rounded-2xl px-6 py-8 mb-4"
      >
        {empty ? (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#8b6dff] to-[#5b3df7] mb-5 flex items-center justify-center shadow-[0_8px_30px_-8px_var(--accent-glow)]">
              <span className="text-white text-xl font-bold">L</span>
            </div>
            <h2 className="text-2xl font-semibold tracking-tight mb-2">How can I help?</h2>
            <p className="text-sm text-[var(--text-muted)] mb-8">
              Every message is streamed, logged, and indexed for observability.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 w-full max-w-2xl">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="text-left text-sm px-4 py-3 rounded-xl border border-[var(--border)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] transition-all text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-6">
            {messages.map((m, i) => (
              <MessageRow
                key={i}
                msg={m}
                pending={streaming && i === messages.length - 1 && !m.content}
              />
            ))}
          </div>
        )}
      </div>

      <div className="max-w-3xl mx-auto w-full">
        <div className="glass rounded-2xl p-3 flex items-end gap-2 focus-within:border-[var(--border-strong)] transition-colors">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Message llm-logger…   (Enter to send, Shift+Enter for newline)"
            rows={1}
            disabled={streaming}
            className="flex-1 bg-transparent resize-none outline-none px-3 py-2 text-sm placeholder:text-[var(--text-faint)] disabled:opacity-60"
            style={{ maxHeight: 200 }}
          />
          {streaming ? (
            <button
              onClick={stop}
              className="btn-ghost rounded-lg px-4 py-2 text-sm flex items-center gap-2"
            >
              <span className="w-3 h-3 rounded-sm bg-[var(--danger)]" />
              Stop
            </button>
          ) : (
            <button
              onClick={() => send()}
              disabled={!input.trim()}
              className="btn-primary rounded-lg px-4 py-2 text-sm font-medium"
            >
              Send ↵
            </button>
          )}
        </div>
        <p className="text-[11px] text-[var(--text-faint)] mt-2 text-center">
          Logs flow through BullMQ → Postgres. Open the dashboard to watch them land.
        </p>
      </div>
    </div>
  );
}

function MessageRow({ msg, pending }: { msg: Msg; pending: boolean }) {
  const isUser = msg.role === "user";
  return (
    <div className={"flex gap-4 fade-in " + (isUser ? "flex-row-reverse" : "")}>
      <div
        className={
          "w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-[11px] font-semibold " +
          (isUser
            ? "bg-[var(--bg-hover)] text-[var(--text-muted)] border border-[var(--border)]"
            : "bg-gradient-to-br from-[#8b6dff] to-[#5b3df7] text-white shadow-[0_4px_12px_-4px_var(--accent-glow)]")
        }
      >
        {isUser ? "You" : "L"}
      </div>
      <div className={"flex-1 min-w-0 " + (isUser ? "text-right" : "")}>
        {isUser ? (
          <div className="inline-block max-w-full whitespace-pre-wrap text-[15px] leading-relaxed bg-[var(--bg-hover)] border border-[var(--border)] rounded-2xl rounded-tr-md px-4 py-2.5 text-left">
            {msg.content}
          </div>
        ) : (
          <div className="md-body max-w-full">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
            {pending && (
              <span className="inline-flex gap-1 ml-1 align-middle">
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--text-muted)] inline-block" />
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--text-muted)] inline-block" />
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--text-muted)] inline-block" />
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
