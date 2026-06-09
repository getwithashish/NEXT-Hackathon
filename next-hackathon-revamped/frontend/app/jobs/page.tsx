"use client";
import { useState, useEffect } from "react";
import { getJobs } from "../../lib/api";

export default function JobsPage() {
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getJobs(50).then(d => setJobs(d.jobs)).catch(console.error).finally(() => setLoading(false));
  }, []);

  const statusColor: Record<string, string> = { pending: "#f59e0b", running: "#6366f1", done: "#22c55e", error: "#ef4444", failed: "#ef4444" };

  return (
    <div>
      <h2 style={{ color: "#6366f1" }}>📋 All Jobs</h2>
      {loading && <div style={{ color: "#666" }}>Loading…</div>}
      {jobs.map(job => (
        <div key={job.job_id} style={{ background: "#1a1a2e", borderRadius: 10, padding: "14px 18px", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 600, color: "#e0e0ff" }}>{job.model_name ?? "Unknown"}</div>
            <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>Job {job.job_id.slice(0, 8)}… · {job.source} · {new Date(job.created_at).toLocaleString()}</div>
            {job.fingerprint_hash && <div style={{ fontSize: 11, color: "#444", marginTop: 2, fontFamily: "monospace" }}>{job.fingerprint_hash.slice(0, 32)}…</div>}
          </div>
          <span style={{ color: statusColor[job.status] ?? "#666", fontWeight: 700, fontSize: 13 }}>{job.status}</span>
        </div>
      ))}
    </div>
  );
}
