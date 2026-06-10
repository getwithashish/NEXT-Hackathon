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
function scoreColor(score: number) {
  if (score >= 95) return "#ef4444"; // danger
  if (score >= 85) return "#f59e0b"; // warning
  if (score >= 70) return "#3b82f6"; // info
  return "#10b981";                  // success/distinct
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
      <div className="flex h-48 items-center justify-center text-[13px] text-text-subtle">
        No similarity data yet
      </div>
    );

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 28, left: -4 }}>
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
            background: "#0f1011",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 6,
            color: "#f7f8f8",
            fontSize: 12,
          }}
          cursor={{ fill: "rgba(255,255,255,0.03)" }}
        />
        <Bar dataKey="score" radius={[3, 3, 0, 0]} maxBarSize={28}>
          {data.map((entry, i) => (
            <Cell key={i} fill={scoreColor(entry.score)} />
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
