"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ClipboardList, Search, X, ArrowUpDown, ArrowUp, ArrowDown,
  ExternalLink, RefreshCw, ChevronLeft, ChevronRight,
} from "lucide-react";
import { GitCompareArrows } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge, statusBadge, verdictBadge } from "@/components/Badge";
import { SimilarityMeter } from "@/components/SimilarityMeter";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/Skeleton";
import { CopyButton } from "@/components/CopyButton";
import { cn } from "@/lib/utils";
import { getJobs, getSimilarFingerprints, type Job, type SimilarFingerprint } from "@/lib/api";

const PAGE_SIZE = 25;

type SortKey = "created_at" | "similarity_score" | "status" | "model_name";
type SortDir  = "asc" | "desc";

function fmt(dateStr?: string | null) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ── Similar Models panel ──────────────────────────────────────────────────────
function SimilarModelsPanel({ jobId, isDone }: { jobId: string; isDone: boolean }) {
  const [similar, setSimilar] = useState<SimilarFingerprint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!isDone) return;
    let cancelled = false;
    setLoading(true); setError(null);
    getSimilarFingerprints(jobId)
      .then((data) => { if (!cancelled) setSimilar(data.similar ?? []); })
      .catch((e)   => { if (!cancelled) setError(e.message ?? "Failed to load"); })
      .finally(()  => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [jobId, isDone]);

  if (!isDone) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <GitCompareArrows className="h-3.5 w-3.5 text-accent-bright" />
        <p className="text-[12px] font-[510] text-text-secondary">Similar Models in Database</p>
        {!loading && similar.length > 0 && (
          <span className="ml-auto text-[11px] text-text-subtle">{similar.length} found</span>
        )}
      </div>
      {loading && (
        <div className="space-y-2">
          {[0,1,2].map(i => (
            <div key={i} className="flex items-center gap-3 rounded border border-white/4 bg-white/[0.015] p-2.5">
              <Skeleton className="h-3 w-32" /><Skeleton className="h-3 w-16 ml-auto" />
            </div>
          ))}
        </div>
      )}
      {!loading && error && <p className="text-[12px] text-danger/80 font-mono">{error}</p>}
      {!loading && !error && similar.length === 0 && (
        <div className="rounded border border-white/4 bg-white/[0.015] p-3 text-center">
          <p className="text-[12px] text-text-subtle">No similar fingerprints found</p>
          <p className="text-[11px] text-text-muted mt-0.5">This model appears behaviorally distinct</p>
        </div>
      )}
      {!loading && !error && similar.length > 0 && (
        <div className="space-y-1.5">
          {similar.map((s, i) => (
            <div key={s.job_id} className="flex items-center gap-3 rounded border border-white/4 bg-white/[0.015] p-2.5 animate-fade-in"
              style={{ animationDelay: `${i * 40}ms` }}>
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/5 text-[10px] font-[510] text-text-subtle">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-[510] text-text-secondary truncate">{s.model_name ?? s.provider_name ?? "Unknown"}</p>
                <p className="text-[10px] text-text-subtle font-mono">{s.job_id.slice(0, 12)}…</p>
              </div>
              <SimilarityMeter value={s.similarity_score} showLabel={false} />
              {s.source && <Badge variant="muted" className="shrink-0 text-[10px]">{s.source}</Badge>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Job detail drawer ─────────────────────────────────────────────────────────
function JobDetailSheet({ job, onClose }: { job: Job; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="fixed right-0 top-0 z-50 h-full w-full sm:max-w-md border-l border-white/6 bg-bg-panel shadow-2xl animate-slide-in-right flex flex-col">
        <div className="flex items-center justify-between border-b border-white/6 px-5 py-4">
          <h2 className="text-[14px] font-[590] text-text-primary">Job Details</h2>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded border border-white/6 text-text-muted hover:bg-white/5 hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              {statusBadge(job.status)}
              {job.verdict && verdictBadge(job.verdict)}
              {job.source && <Badge variant="muted">{job.source}</Badge>}
            </div>
            <div>
              <p className="text-lg font-[590] text-text-primary" style={{ letterSpacing: "-0.2px" }}>
                {job.model_name ?? "Unknown Model"}
              </p>
              <p className="text-[12px] text-text-muted">{job.model_type}</p>
            </div>
          </div>

          <div className="space-y-2 rounded border border-white/5 bg-white/[0.015] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-[510] uppercase tracking-wider text-text-subtle">Job ID</span>
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-mono text-[11px] text-text-muted truncate">{job.job_id}</span>
                <CopyButton value={job.job_id} />
              </div>
            </div>
            {job.workflow_run_id && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-[510] uppercase tracking-wider text-text-subtle">Run ID</span>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-mono text-[11px] text-text-muted truncate">{job.workflow_run_id}</span>
                  <CopyButton value={job.workflow_run_id} />
                </div>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-[510] uppercase tracking-wider text-text-subtle">Created</span>
              <span className="text-[12px] text-text-muted">{fmt(job.created_at)}</span>
            </div>
            {job.completed_at && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-[510] uppercase tracking-wider text-text-subtle">Completed</span>
                <span className="text-[12px] text-text-muted">{fmt(job.completed_at)}</span>
              </div>
            )}
          </div>

          {job.similarity_score != null && job.similarity_score > 0 && (
            <SimilarityMeter value={job.similarity_score} />
          )}

          {job.fingerprint_hash && (
            <div className="space-y-2">
              <p className="text-[12px] font-[510] text-text-secondary">Fingerprint Hash</p>
              <div className="flex items-center gap-2 rounded border border-white/5 bg-bg-base p-2.5">
                <span className="font-mono text-[11px] text-text-muted break-all">{job.fingerprint_hash}</span>
                <CopyButton value={job.fingerprint_hash} className="shrink-0" />
              </div>
            </div>
          )}

          {job.matched_model && (
            <div className="rounded border border-warning/10 bg-warning/[0.04] p-3">
              <p className="text-[11px] text-text-subtle mb-1">Most similar to</p>
              <p className="text-[14px] font-[590] text-warning">{job.matched_model}</p>
            </div>
          )}

          {job.status === "done" && (
            <div className="rounded border border-white/5 bg-white/[0.015] p-3">
              <SimilarModelsPanel jobId={job.job_id} isDone />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Pagination ────────────────────────────────────────────────────────────────
function Pagination({
  page, pages, total, limit, onChange,
}: { page: number; pages: number; total: number; limit: number; onChange: (p: number) => void }) {
  if (pages <= 1) return null;
  const start = (page - 1) * limit + 1;
  const end   = Math.min(page * limit, total);

  return (
    <div className="flex items-center justify-between px-1 pt-3">
      <span className="text-[12px] text-text-subtle">
        {start}–{end} of {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(page - 1)} disabled={page <= 1}
          className="flex h-7 w-7 items-center justify-center rounded border border-white/6 text-text-muted transition-colors hover:bg-white/5 hover:text-text-secondary disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        {/* Page numbers */}
        {Array.from({ length: Math.min(pages, 7) }, (_, i) => {
          let p: number;
          if (pages <= 7) p = i + 1;
          else if (page <= 4) p = i + 1;
          else if (page >= pages - 3) p = pages - 6 + i;
          else p = page - 3 + i;
          return (
            <button
              key={p}
              onClick={() => onChange(p)}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded text-[12px] font-[510] transition-colors",
                p === page
                  ? "bg-accent/15 text-accent-bright border border-accent/20"
                  : "border border-white/4 text-text-muted hover:bg-white/5 hover:text-text-secondary"
              )}
            >
              {p}
            </button>
          );
        })}
        <button
          onClick={() => onChange(page + 1)} disabled={page >= pages}
          className="flex h-7 w-7 items-center justify-center rounded border border-white/6 text-text-muted transition-colors hover:bg-white/5 hover:text-text-secondary disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function JobsPage() {
  const [allJobs,      setAllJobs]      = useState<Job[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey,      setSortKey]      = useState<SortKey>("created_at");
  const [sortDir,      setSortDir]      = useState<SortDir>("desc");
  const [selected,     setSelected]     = useState<Job | null>(null);
  const [page,         setPage]         = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch all jobs (up to 200) for client-side filter/sort/paginate
      const data = await getJobs({ limit: 200, page: 1 });
      setAllJobs(data.jobs ?? []);
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Reset page on filter/sort change
  useEffect(() => { setPage(1); }, [search, statusFilter, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  const filtered = allJobs
    .filter((j) => {
      const q = search.toLowerCase();
      const matchSearch = !q ||
        j.model_name?.toLowerCase().includes(q) ||
        j.job_id?.toLowerCase().includes(q);
      const matchStatus = statusFilter === "all" || j.status === statusFilter;
      return matchSearch && matchStatus;
    })
    .sort((a, b) => {
      let va = (a as any)[sortKey] ?? "";
      let vb = (b as any)[sortKey] ?? "";
      if (sortDir === "desc") [va, vb] = [vb, va];
      return va < vb ? -1 : va > vb ? 1 : 0;
    });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated  = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 text-text-subtle" />;
    return sortDir === "asc"
      ? <ArrowUp className="h-3 w-3 text-accent-bright" />
      : <ArrowDown className="h-3 w-3 text-accent-bright" />;
  }

  const statuses = ["all", ...Array.from(new Set(allJobs.map(j => j.status)))];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="All Jobs"
        subtitle={loading ? "Loading…" : `${filtered.length} job${filtered.length !== 1 ? "s" : ""}`}
        icon={ClipboardList}
        action={
          <button
            onClick={load} disabled={loading}
            className="flex items-center gap-1.5 rounded border border-white/6 bg-white/[0.02] px-3 py-1.5 text-[13px] text-text-muted hover:bg-white/[0.04] hover:text-text-secondary transition-colors disabled:opacity-50"
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
            placeholder="Search by model or job ID…"
            className="w-full rounded border border-white/6 bg-white/[0.02] pl-9 pr-3 py-2 text-[13px] text-text-primary placeholder-text-subtle focus:border-accent/30 focus:outline-none focus:ring-1 focus:ring-accent/10 transition-colors"
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

      {/* Table */}
      <div className="surface-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-[13px]">
            <thead className="border-b border-white/[0.07] bg-white/[0.03]">
              <tr>
                {([
                  ["model_name",       "Model"],
                  ["status",           "Status"],
                  ["similarity_score", "Similarity"],
                  ["created_at",       "Date"],
                ] as [SortKey, string][]).map(([key, label]) => (
                  <th
                    key={key}
                    className="cursor-pointer px-4 py-2.5 text-[11px] font-[510] uppercase tracking-wider text-text-subtle hover:text-text-muted transition-colors select-none"
                    onClick={() => toggleSort(key)}
                  >
                    <span className="flex items-center gap-1.5">{label} <SortIcon col={key} /></span>
                  </th>
                ))}
                <th className="hidden sm:table-cell px-4 py-2.5 text-[11px] font-[510] uppercase tracking-wider text-text-subtle">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {loading && Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="animate-fade-in" style={{ animationDelay: `${i * 30}ms` }}>
                  <td className="px-4 py-3"><Skeleton className="h-4 w-36" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-5 w-16 rounded-full" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-3 w-24" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-3 w-28" /></td>
                  <td className="hidden sm:table-cell px-4 py-3"><Skeleton className="h-5 w-14 rounded-full" /></td>
                </tr>
              ))}

              {!loading && paginated.length === 0 && (
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

              {!loading && paginated.map((job, i) => (
                <tr
                  key={job.job_id}
                  onClick={() => setSelected(job)}
                  className="cursor-pointer transition-colors hover:bg-white/[0.02] animate-fade-in"
                  style={{ animationDelay: `${Math.min(i * 20, 200)}ms` }}
                >
                  <td className="px-4 py-3">
                    <div className="font-[510] text-text-secondary">
                      {job.model_name ?? "Unknown"}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-text-subtle">
                      {job.job_id?.slice(0, 10)}…
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      {statusBadge(job.status)}
                      {job.verdict && <div className="mt-0.5">{verdictBadge(job.verdict)}</div>}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {job.similarity_score != null && job.similarity_score > 0
                      ? <SimilarityMeter value={job.similarity_score} showLabel={false} />
                      : <span className="text-text-subtle text-[12px]">—</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-text-muted whitespace-nowrap text-[12px]">
                    {fmt(job.created_at)}
                  </td>
                  <td className="hidden sm:table-cell px-4 py-3">
                    {job.source
                      ? <Badge variant="muted">{job.source}</Badge>
                      : <span className="text-text-subtle">—</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!loading && filtered.length > PAGE_SIZE && (
          <div className="border-t border-white/[0.04] px-4 py-3">
            <Pagination
              page={page}
              pages={totalPages}
              total={filtered.length}
              limit={PAGE_SIZE}
              onChange={setPage}
            />
          </div>
        )}
      </div>

      {/* Side drawer */}
      {selected && <JobDetailSheet job={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
