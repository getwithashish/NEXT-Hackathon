"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell,
} from "recharts";

interface Job {
  model_name?: string | null;
  similarity_score?: number | null;
  status: string;
  created_at: string;
  type?: string;
}

function truncate(s: string | null | undefined, n: number) {
  if (!s) return "unknown";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Consistent thresholds: ≥0.95 clone, ≥0.85 high, ≥0.70 same-family, else distinct
function gradFor(score: number) {
  if (score >= 95) return "url(#grad-danger)";
  if (score >= 85) return "url(#grad-warning)";
  if (score >= 70) return "url(#grad-info)";
  return "url(#grad-success)";
}

export function SimilarityBarChart({ jobs }: { jobs: Job[] }) {
  const data = jobs
    .filter((j) => j.similarity_score != null && j.model_name)
    .slice(0, 14)
    .map((j) => ({
      name:  truncate(j.model_name, 12),
      score: Math.round((j.similarity_score ?? 0) * 100),
    }));

  if (!data.length)
    return (
      <div className="flex h-[220px] flex-col items-center justify-center gap-2 text-text-subtle">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.02]">
          <svg className="h-5 w-5 text-text-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
          </svg>
        </div>
        <p className="text-[13px]">No similarity data yet</p>
      </div>
    );

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 28, left: -4 }}>
        <defs>
          <linearGradient id="grad-danger" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff6b6b" /><stop offset="100%" stopColor="#ef4444" />
          </linearGradient>
          <linearGradient id="grad-warning" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fbbf24" /><stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>
          <linearGradient id="grad-info" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#60a5fa" /><stop offset="100%" stopColor="#3b82f6" />
          </linearGradient>
          <linearGradient id="grad-success" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" /><stop offset="100%" stopColor="#10b981" />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 10, fill: "#62666d" }}
          angle={-35}
          textAnchor="end"
          interval={0}
          height={52}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "#62666d" }}
          domain={[0, 100]}
          unit="%"
          width={32}
        />
        <Tooltip
          formatter={(v: any) => [`${v}%`, "Similarity"]}
          contentStyle={{
            background: "rgba(15,16,17,0.95)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            color: "#f7f8f8",
            fontSize: 12,
            boxShadow: "0 8px 24px -8px rgba(0,0,0,0.6)",
          }}
          cursor={{ fill: "rgba(255,255,255,0.03)" }}
        />
        <Bar dataKey="score" radius={[3, 3, 0, 0]} maxBarSize={28} minPointSize={3}>
          {data.map((entry, i) => (
            <Cell key={i} fill={gradFor(entry.score)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function StatusDonutRow({ jobs }: { jobs: Job[] }) {
  const counts: Record<string, number> = {};
  jobs.forEach((j) => { counts[j.status] = (counts[j.status] ?? 0) + 1; });
  const total = jobs.length;
  if (!total) return null;

  const statuses = [
    { key: "done",    color: "#10b981", label: "Done" },
    { key: "running", color: "#3b82f6", label: "Running" },
    { key: "failed",  color: "#ef4444", label: "Failed" },
    { key: "pending", color: "#f59e0b", label: "Pending" },
  ];

  return (
    <div className="flex flex-wrap gap-3">
      {statuses.filter((s) => counts[s.key]).map((s) => (
        <div key={s.key} className="flex items-center gap-1.5">
          <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.color }} />
          <span className="text-[11px] text-text-muted">{s.label}</span>
          <span className="font-mono text-[11px] font-[500] text-text-secondary">{counts[s.key]}</span>
        </div>
      ))}
    </div>
  );
}
