"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, BarChart, Bar, CartesianGrid, Legend, Area, AreaChart,
} from "recharts";

type Metrics = {
  since: string;
  summary: {
    requests: number;
    errors: number;
    errorRate: number;
    avgLatencyMs: number | null;
    avgTtfbMs: number | null;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  };
  buckets: Array<{
    bucket: string;
    total: number;
    errors: number;
    p50: number | null;
    p95: number | null;
    tokens: number;
  }>;
};

function fmt(n: number | null | undefined, suffix = "") {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M" + suffix;
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k" + suffix;
  return Math.round(n).toLocaleString() + suffix;
}

const CHART_COLORS = {
  primary: "#7c5cff",
  success: "#4ade80",
  danger: "#f87171",
  warn: "#fbbf24",
  grid: "#1f1f25",
  axis: "#5a5a64",
};

export default function DashboardPage() {
  const [m, setM] = useState<Metrics | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    let ctl: AbortController | null = null;
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      ctl?.abort();
      ctl = new AbortController();
      try {
        const r = await fetch("/api/metrics", { signal: ctl.signal });
        const data = await r.json();
        if (!cancelled) {
          setM(data);
          setLastUpdated(Date.now());
        }
      } catch (err: any) {
        if (err?.name !== "AbortError") console.error("[dashboard] fetch failed", err);
      }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      ctl?.abort();
      clearInterval(t);
    };
  }, []);

  const chartData = useMemo(
    () =>
      m?.buckets.map((b) => ({
        time: new Date(b.bucket).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        p50: b.p50 ? Math.round(b.p50) : 0,
        p95: b.p95 ? Math.round(b.p95) : 0,
        requests: b.total,
        errors: b.errors,
        tokens: b.tokens,
      })) ?? [],
    [m]
  );

  if (!m) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 shimmer rounded-md bg-[var(--bg-elevated)]" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0,1,2,3,4,5,6,7].map((i) => (
            <div key={i} className="h-24 shimmer rounded-xl bg-[var(--bg-elevated)]" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Last 24 hours · refreshing every 10s</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--text-faint)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] animate-pulse" />
          live · updated {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "—"}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Requests" value={fmt(m.summary.requests)} accent="primary" />
        <Kpi
          label="Error rate"
          value={(m.summary.errorRate * 100).toFixed(1) + "%"}
          sub={`${m.summary.errors} errors`}
          accent={m.summary.errorRate > 0.05 ? "danger" : "success"}
        />
        <Kpi label="Avg latency" value={fmt(m.summary.avgLatencyMs, " ms")} accent="warn" />
        <Kpi label="Avg TTFB" value={fmt(m.summary.avgTtfbMs, " ms")} accent="primary" />
        <Kpi label="Total tokens" value={fmt(m.summary.totalTokens)} />
        <Kpi label="Prompt tokens" value={fmt(m.summary.promptTokens)} />
        <Kpi label="Completion tokens" value={fmt(m.summary.completionTokens)} />
        <Kpi
          label="Cost"
          value={"$" + (m.summary.costUsd ?? 0).toFixed(4)}
          sub="per-model rates"
        />
      </div>

      <ChartCard title="Latency" subtitle="p50 / p95 per hour, milliseconds">
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
          <XAxis dataKey="time" stroke={CHART_COLORS.axis} fontSize={11} />
          <YAxis stroke={CHART_COLORS.axis} fontSize={11} />
          <Tooltip
            contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "var(--text-muted)" }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="p50" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="p95" stroke={CHART_COLORS.danger} strokeWidth={2} dot={false} />
        </LineChart>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Throughput" subtitle="Requests vs errors per hour">
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="time" stroke={CHART_COLORS.axis} fontSize={11} />
            <YAxis stroke={CHART_COLORS.axis} fontSize={11} />
            <Tooltip
              contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "var(--text-muted)" }}
            />
            <Bar dataKey="requests" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} />
            <Bar dataKey="errors" fill={CHART_COLORS.danger} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartCard>

        <ChartCard title="Tokens" subtitle="Total tokens consumed per hour">
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="tokenGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.success} stopOpacity={0.4} />
                <stop offset="100%" stopColor={CHART_COLORS.success} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="time" stroke={CHART_COLORS.axis} fontSize={11} />
            <YAxis stroke={CHART_COLORS.axis} fontSize={11} />
            <Tooltip
              contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "var(--text-muted)" }}
            />
            <Area type="monotone" dataKey="tokens" stroke={CHART_COLORS.success} strokeWidth={2} fill="url(#tokenGradient)" />
          </AreaChart>
        </ChartCard>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "primary" | "success" | "danger" | "warn";
}) {
  const accentColor = accent
    ? { primary: "var(--accent)", success: "var(--success)", danger: "var(--danger)", warn: "var(--warn)" }[accent]
    : undefined;
  return (
    <div className="glass rounded-xl p-4 hover:border-[var(--border-strong)] transition-colors">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
        {accentColor && <span className="w-1 h-1 rounded-full" style={{ background: accentColor }} />}
        {label}
      </div>
      <div className="text-2xl font-semibold mt-2 font-mono-num tracking-tight" style={accentColor ? { color: accentColor } : {}}>
        {value}
      </div>
      {sub && <div className="text-xs text-[var(--text-faint)] mt-1 font-mono-num">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactElement }) {
  return (
    <div className="glass rounded-2xl p-5">
      <div className="mb-4">
        <h3 className="text-sm font-medium">{title}</h3>
        {subtitle && <p className="text-xs text-[var(--text-muted)] mt-0.5">{subtitle}</p>}
      </div>
      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </div>
  );
}
