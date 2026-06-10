"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, ScatterChart, Scatter, ZAxis,
} from "recharts";

interface Job {
  model_name?: string;
  similarity_score?: number;
  status: string;
  created_at: string;
  type: string;
}

function truncate(s: string, n: number) {
  return s?.length > n ? s.slice(0, n) + "…" : s;
}

export function SimilarityBarChart({ jobs }: { jobs: Job[] }) {
  const data = jobs
    .filter((j) => j.similarity_score != null && j.model_name)
    .slice(0, 12)
    .map((j) => ({
      name: truncate(j.model_name ?? "unknown", 14),
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
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 20, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 11, fill: "#8a8f98" }}
          angle={-35}
          textAnchor="end"
          interval={0}
          height={50}
        />
        <YAxis tick={{ fontSize: 11, fill: "#8a8f98" }} domain={[0, 100]} unit="%" />
        <Tooltip
          formatter={(v: any) => [`${v}%`, "Similarity"] as any}
          contentStyle={{ background: "#191a1b", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#f7f8f8" }}
        />
        <Bar dataKey="score" radius={[3, 3, 0, 0]} maxBarSize={32}>
          {data.map((entry, i) => (
            <Cell
              key={i}
              fill={entry.score >= 90 ? "#ef4444" : entry.score >= 75 ? "#f59e0b" : entry.score >= 50 ? "#3b82f6" : "#5e6ad2"}
            />
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
        <div key={s.key} className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
          <span className="text-[12px] text-text-muted">{s.label}</span>
          <span className="font-mono text-[12px] font-[500] text-text-secondary">{counts[s.key]}</span>
        </div>
      ))}
    </div>
  );
}
