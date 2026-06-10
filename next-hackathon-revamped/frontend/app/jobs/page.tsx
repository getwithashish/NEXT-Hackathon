"use client";

import { useState, useEffect, useCallback } from "react";
import { ClipboardList, Search, X, ArrowUpDown, ArrowUp, ArrowDown, ExternalLink, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge, statusBadge } from "@/components/Badge";
import { SimilarityMeter } from "@/components/SimilarityMeter";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/Skeleton";
import { CopyButton } from "@/components/CopyButton";
import { cn } from "@/lib/utils";
import { getJobs } from "@/lib/api";

type SortKey = "created_at" | "similarity_score" | "status" | "model_name";
type SortDir = "asc" | "desc";

function fmt(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function JobDetailSheet({ job, onClose }: { job: any; onClose: () => void }) {
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
      />
      {/* Sheet */}
      <div className="fixed right-0 top-0 z-50 h-full w-full sm:max-w-md border-l border-white/8 bg-bg-panel shadow-2xl animate-slide-in-right flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/8 px-5 py-4">
          <h2 className="text-[14px] font-[590] text-text-primary">Job Details</h2>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded border border-white/8 text-text-muted hover:bg-white/5 hover:text-text-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {/* Status + Model */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              {statusBadge(job.status)}
              {job.type && <Badge variant="muted">{job.type}</Badge>}
            </div>
            <div>
              <p className="text-lg font-[590] text-text-primary" style={{ letterSpacing: "-0.2px" }}>
                {job.model_name ?? job.provider_name ?? "Unknown Model"}
              </p>
              <p className="text-[12px] text-text-muted">{job.provider_name}</p>
            </div>
          </div>

          {/* IDs */}
          <div className="space-y-2 rounded-md border border-white/5 bg-white/[0.02] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-[510] uppercase tracking-wider text-text-subtle">Job ID</span>
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-mono text-[11px] text-text-muted truncate">{job.job_id}</span>
                <CopyButton value={job.job_id} />
              </div>
            </div>
            {job.run_id && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-[510] uppercase tracking-wider text-text-subtle">Run ID</span>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-mono text-[11px] text-text-muted truncate">{job.run_id}</span>
                  <CopyButton value={job.run_id} />
                </div>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-[510] uppercase tracking-wider text-text-subtle">Created</span>
              <span className="text-[12px] text-text-muted">{fmt(job.created_at)}</span>
            </div>
          </div>

          {/* Similarity */}
          {job.similarity_score != null && (
            <div className="space-y-2">
              <p className="text-[12px] font-[510] text-text-secondary">Similarity Score</p>
              <SimilarityMeter value={job.similarity_score} />
            </div>
          )}

          {/* Fingerprint hash */}
          {job.fingerprint_hash && (
            <div className="space-y-2">
              <p className="text-[12px] font-[510] text-text-secondary">Fingerprint Hash</p>
              <div className="flex items-center gap-2 rounded border border-white/5 bg-bg-base p-2.5">
                <span className="font-mono text-[11px] text-text-muted break-all">{job.fingerprint_hash}</span>
                <CopyButton value={job.fingerprint_hash} className="shrink-0" />
              </div>
            </div>
          )}

          {/* Matched model */}
          {job.matched_model && (
            <div className="rounded border border-warning/15 bg-warning/5 p-3">
              <p className="text-[11px] text-text-subtle mb-1">Most similar to</p>
              <p className="text-[14px] font-[590] text-warning">{job.matched_model}</p>
            </div>
          )}

          {/* Error */}
          {job.error_message && (
            <div className="rounded border border-danger/15 bg-danger/5 p-3">
              <p className="text-[11px] text-text-subtle mb-1">Error</p>
              <p className="text-[12px] text-danger font-mono">{job.error_message}</p>
            </div>
          )}

          {/* API endpoint */}
          {job.api_endpoint && (
            <div className="space-y-1.5">
              <p className="text-[12px] font-[510] text-text-secondary">API Endpoint</p>
              <a
                href={job.api_endpoint}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[12px] text-accent-bright hover:text-accent-hover transition-colors"
              >
                {job.api_endpoint} <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default function JobsPage() {
  const [jobs,      setJobs]      = useState<any[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey,   setSortKey]   = useState<SortKey>("created_at");
  const [sortDir,   setSortDir]   = useState<SortDir>("desc");
  const [selected,  setSelected]  = useState<any | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getJobs(50);
      setJobs(data.jobs ?? []);
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  const filtered = jobs
    .filter((j) => {
      const q = search.toLowerCase();
      const matchSearch = !q ||
        j.model_name?.toLowerCase().includes(q) ||
        j.provider_name?.toLowerCase().includes(q) ||
        j.job_id?.toLowerCase().includes(q);
      const matchStatus = statusFilter === "all" || j.status === statusFilter;
      return matchSearch && matchStatus;
    })
    .sort((a, b) => {
      let va = a[sortKey] ?? "";
      let vb = b[sortKey] ?? "";
      if (sortDir === "desc") [va, vb] = [vb, va];
      return va < vb ? -1 : va > vb ? 1 : 0;
    });

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 text-text-subtle" />;
    return sortDir === "asc"
      ? <ArrowUp className="h-3 w-3 text-accent-bright" />
      : <ArrowDown className="h-3 w-3 text-accent-bright" />;
  }

  const statuses = ["all", ...Array.from(new Set(jobs.map((j) => j.status)))];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="All Jobs"
        subtitle={`${jobs.length} fingerprint job${jobs.length !== 1 ? "s" : ""}`}
        icon={ClipboardList}
        action={
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 rounded border border-white/8 bg-white/[0.02] px-3 py-1.5 text-[13px] text-text-muted hover:bg-white/[0.04] hover:text-text-secondary transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </button>
        }
      />

      {/* Filters */}
      <div className="mb-4 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2 sm:gap-3">
        <div className="relative flex-1 min-w-0 sm:min-w-48">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by model, provider, job ID…"
            className="w-full rounded border border-white/8 bg-white/[0.02] pl-9 pr-3 py-2 text-[13px] text-text-primary placeholder-text-subtle focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/10"
          />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {statuses.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                "rounded px-2.5 py-1 text-[12px] font-[510] transition-colors",
                statusFilter === s
                  ? "bg-accent/15 text-accent-bright"
                  : "text-text-muted hover:bg-white/5 hover:text-text-secondary"
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Table — horizontally scrollable on mobile */}
      <div className="overflow-hidden rounded-md border border-white/8">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-[13px]">
            <thead className="border-b border-white/8 bg-white/[0.02]">
              <tr>
                {([
                  ["model_name",       "Model"],
                  ["status",           "Status"],
                  ["similarity_score", "Similarity"],
                  ["created_at",       "Date"],
                ] as [SortKey, string][]).map(([key, label]) => (
                  <th
                    key={key}
                    className="cursor-pointer px-4 py-2.5 text-[11px] font-[510] uppercase tracking-wider text-text-subtle hover:text-text-muted transition-colors"
                    onClick={() => toggleSort(key)}
                  >
                    <span className="flex items-center gap-1.5">{label} <SortIcon col={key} /></span>
                  </th>
                ))}
                <th className="hidden sm:table-cell px-4 py-2.5 text-[11px] font-[510] uppercase tracking-wider text-text-subtle">Type</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {loading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td className="px-4 py-3"><Skeleton className="h-4 w-36" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-5 w-16 rounded-full" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-3 w-24" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-3 w-28" /></td>
                  <td className="hidden sm:table-cell px-4 py-3"><Skeleton className="h-5 w-14 rounded-full" /></td>
                </tr>
              ))}

              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      icon={ClipboardList}
                      title="No jobs found"
                      description={search ? "Try a different search term" : "Submit a model to get started"}
                      className="py-12"
                    />
                  </td>
                </tr>
              )}

              {!loading && filtered.map((job, i) => (
                <tr
                  key={job.job_id}
                  onClick={() => setSelected(job)}
                  className="cursor-pointer transition-colors hover:bg-white/[0.025] animate-fade-in"
                  style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
                >
                  <td className="px-4 py-3">
                    <div className="font-[510] text-text-secondary">
                      {job.model_name ?? job.provider_name ?? "Unknown"}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-text-subtle">
                      {job.job_id?.slice(0, 10)}…
                    </div>
                  </td>
                  <td className="px-4 py-3">{statusBadge(job.status)}</td>
                  <td className="px-4 py-3">
                    {job.similarity_score != null
                      ? <SimilarityMeter value={job.similarity_score} showLabel={false} />
                      : <span className="text-text-subtle">—</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                    {fmt(job.created_at)}
                  </td>
                  <td className="hidden sm:table-cell px-4 py-3">
                    {job.type ? <Badge variant="muted">{job.type}</Badge> : <span className="text-text-subtle">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Side drawer */}
      {selected && (
        <JobDetailSheet job={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
