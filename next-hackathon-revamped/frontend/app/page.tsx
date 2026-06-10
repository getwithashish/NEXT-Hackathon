"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Fingerprint, Layers, AlertTriangle, Clock, ArrowRight,
  X, Search, ExternalLink,
} from "lucide-react";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { SimilarityBarChart, StatusDonutRow } from "@/components/Charts";
import { statusBadge, verdictBadge } from "@/components/Badge";
import { SimilarityMeter } from "@/components/SimilarityMeter";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/Skeleton";
import { CopyButton } from "@/components/CopyButton";
import { getJobs, getStats, getSimilarFingerprints, type Job, type SimilarFingerprint } from "@/lib/api";
import { cn } from "@/lib/utils";
import { GitCompareArrows } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────
type DrillFilter = "fingerprinted" | "providers" | "suspects" | "pending" | null;

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmt(dateStr?: string | null) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ── Similar models sub-panel (reused from jobs page) ──────────────────────────
function SimilarModelsPanel({ jobId, isDone }: { jobId: string; isDone: boolean }) {
  const [similar, setSimilar] = useState<SimilarFingerprint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    if (!isDone) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSimilarFingerprints(jobId)
      .then((data) => { if (!cancelled) setSimilar(data.similar ?? []); })
      .catch((e)   => { if (!cancelled) setError(e.message ?? "Failed"); })
      .finally(()  => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [jobId, isDone]);

  if (!isDone) return null;

  return (
    <div className="space-y-3 mt-4 pt-4 border-t border-white/5">
      <div className="flex items-center gap-2">
        <GitCompareArrows className="h-3.5 w-3.5 text-accent-bright" />
        <p className="text-[12px] font-[510] text-text-secondary">Similar Models</p>
        {!loading && similar.length > 0 && (
          <span className="ml-auto text-[11px] text-text-subtle">{similar.length} found</span>
        )}
      </div>
      {loading && (
        <div className="space-y-2">
          {[0,1,2].map(i => (
            <div key={i} className="flex items-center gap-3 rounded border border-white/4 bg-white/[0.015] p-2.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-16 ml-auto" />
            </div>
          ))}
        </div>
      )}
      {!loading && error && <p className="text-[12px] text-danger/80 font-mono">{error}</p>}
      {!loading && !error && similar.length === 0 && (
        <p className="text-[12px] text-text-subtle">No similar fingerprints found — this model appears behaviorally distinct.</p>
      )}
      {!loading && !error && similar.length > 0 && (
        <div className="space-y-1.5">
          {similar.map((s, i) => (
            <div key={s.job_id} className="flex items-center gap-3 rounded border border-white/4 bg-white/[0.015] p-2.5 animate-fade-in"
              style={{ animationDelay: `${i * 30}ms` }}>
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/5 text-[10px] text-text-subtle">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-[510] text-text-secondary truncate">{s.model_name ?? "Unknown"}</p>
                <p className="text-[10px] text-text-subtle font-mono">{s.job_id.slice(0,12)}…</p>
              </div>
              <SimilarityMeter value={s.similarity_score} showLabel={false} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Job detail side-drawer ─────────────────────────────────────────────────────
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
            </div>
            <div>
              <p className="text-lg font-[590] text-text-primary" style={{ letterSpacing: "-0.2px" }}>
                {job.model_name ?? "Unknown Model"}
              </p>
              <p className="text-[12px] text-text-muted">{job.source}</p>
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

// ── Drill-down modal — filtered job list ──────────────────────────────────────
function DrillModal({
  filter, jobs, loading, onClose, onSelectJob,
}: {
  filter: DrillFilter;
  jobs: Job[];
  loading: boolean;
  onClose: () => void;
  onSelectJob: (job: Job) => void;
}) {
  const [search, setSearch] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = filter === "fingerprinted" ? "All Fingerprinted Models"
    : filter === "providers"      ? "Unique Providers"
    : filter === "suspects"       ? "Clone Suspects"
    : filter === "pending"        ? "Pending / Running Jobs"
    : "Jobs";

  const filtered = jobs.filter((j) => {
    const q = search.toLowerCase();
    const matchSearch = !q ||
      j.model_name?.toLowerCase().includes(q) ||
      j.job_id?.toLowerCase().includes(q);

    if (filter === "fingerprinted") return matchSearch;
    if (filter === "providers") {
      const prov = j.model_name?.split("/")[0] ?? "unknown";
      return matchSearch;
    }
    if (filter === "suspects") return matchSearch && (j.similarity_score ?? 0) >= 0.95;
    if (filter === "pending")  return matchSearch && (j.status === "pending" || j.status === "running");
    return matchSearch;
  });

  // For providers view, deduplicate by provider
  const displayRows = filter === "providers"
    ? Object.values(
        filtered.reduce((acc, j) => {
          const prov = j.model_name?.split("/")[0] ?? "unknown";
          if (!acc[prov]) acc[prov] = { prov, count: 0, jobs: [] as Job[] };
          acc[prov].count++;
          acc[prov].jobs.push(j);
          return acc;
        }, {} as Record<string, { prov: string; count: number; jobs: Job[] }>)
      ).sort((a: any, b: any) => b.count - a.count)
    : null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="fixed inset-x-4 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 top-[5vh] z-50 w-full sm:w-[640px] max-h-[85vh] flex flex-col rounded-lg border border-white/8 bg-bg-panel shadow-2xl animate-fade-in overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/6 px-5 py-4 shrink-0">
          <h2 className="text-[15px] font-[590] text-text-primary">{title}</h2>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded border border-white/6 text-text-muted hover:bg-white/5 hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-white/5 shrink-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-subtle" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by name or ID…"
              className="w-full rounded border border-white/6 bg-white/[0.02] pl-9 pr-3 py-2 text-[13px] text-text-primary placeholder-text-subtle focus:border-accent/30 focus:outline-none focus:ring-1 focus:ring-accent/10 transition-colors"
              autoFocus
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="space-y-2 p-4">
              {[0,1,2,3,4].map(i => (
                <div key={i} className="flex items-center gap-3 rounded border border-white/4 p-3">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-16 ml-auto" />
                </div>
              ))}
            </div>
          )}

          {!loading && filter === "providers" && displayRows && (
            <div className="divide-y divide-white/[0.04]">
              {(displayRows as any[]).map(({ prov, count, jobs: provJobs }, i) => (
                <div key={prov} className="px-5 py-3 animate-fade-in" style={{ animationDelay: `${i * 20}ms` }}>
                  <div className="flex items-center justify-between">
                    <p className="text-[14px] font-[510] text-text-secondary capitalize">{prov}</p>
                    <span className="text-[12px] text-text-muted font-mono">{count} model{count !== 1 ? "s" : ""}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(provJobs as Job[]).slice(0, 8).map((j) => (
                      <button
                        key={j.job_id}
                        onClick={() => { onClose(); onSelectJob(j); }}
                        className="rounded border border-white/5 bg-white/[0.02] px-2 py-0.5 text-[11px] text-text-muted hover:bg-white/[0.05] hover:text-text-secondary transition-colors"
                      >
                        {j.model_name?.split("/")[1] ?? j.model_name ?? j.job_id.slice(0,8)}
                      </button>
                    ))}
                    {(provJobs as Job[]).length > 8 && (
                      <span className="text-[11px] text-text-subtle self-center">+{(provJobs as Job[]).length - 8} more</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && filter !== "providers" && filtered.length === 0 && (
            <div className="py-16 text-center">
              <p className="text-[13px] text-text-subtle">No results</p>
            </div>
          )}

          {!loading && filter !== "providers" && filtered.map((job, i) => (
            <button
              key={job.job_id}
              onClick={() => { onClose(); onSelectJob(job); }}
              className="w-full flex items-center gap-3 px-5 py-3 border-b border-white/[0.04] hover:bg-white/[0.025] transition-colors text-left animate-fade-in"
              style={{ animationDelay: `${Math.min(i * 20, 300)}ms` }}
            >
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-[510] text-text-secondary truncate">
                  {job.model_name ?? "Unknown"}
                </p>
                <p className="text-[11px] font-mono text-text-subtle">{job.job_id.slice(0,12)}… · {fmt(job.created_at)}</p>
              </div>
              <div className="shrink-0 flex flex-col items-end gap-1">
                {statusBadge(job.status)}
                {job.similarity_score != null && (
                  <SimilarityMeter value={job.similarity_score} showLabel={false} />
                )}
              </div>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-white/5 px-5 py-3 shrink-0 flex items-center justify-between">
          <span className="text-[12px] text-text-subtle">
            {filter !== "providers" ? `${filtered.length} result${filtered.length !== 1 ? "s" : ""}` : `${(displayRows as any[]).length} provider${(displayRows as any[])?.length !== 1 ? "s" : ""}`}
          </span>
          <Link href="/jobs" onClick={onClose} className="flex items-center gap-1 text-[12px] text-accent-bright hover:text-accent-hover transition-colors">
            View all jobs <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </>
  );
}

// ── Clickable stat card wrapper ────────────────────────────────────────────────
function ClickableStatCard({ onClick, ...props }: React.ComponentProps<typeof StatCard> & { onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full text-left group">
      <StatCard {...props} className="group-hover:bg-white/[0.04] group-hover:border-white/10 transition-all duration-200 cursor-pointer" />
    </button>
  );
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [jobs,          setJobs]         = useState<Job[]>([]);
  const [stats,         setStats]        = useState<any>(null);
  const [pendingCount,  setPendingCount] = useState(0);
  const [loading,       setLoading]      = useState(true);
  const [drill,         setDrill]        = useState<DrillFilter>(null);
  const [selectedJob,   setSelectedJob]  = useState<Job | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [jobsRes, statsRes, pendingRes] = await Promise.all([
        fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "https://backend-three-zeta-94.vercel.app"}/api/jobs?limit=200`, { cache: "no-store" }).then(r => r.json()),
        fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "https://backend-three-zeta-94.vercel.app"}/api/stats`, { cache: "no-store" }).then(r => r.json()).catch(() => null),
        fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "https://backend-three-zeta-94.vercel.app"}/api/approval/pending`, { cache: "no-store" }).then(r => r.json()).catch(() => ({ pending: [] })),
      ]);
      setJobs(jobsRes.jobs ?? []);
      setStats(statsRes);
      setPendingCount(pendingRes?.pending?.length ?? 0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 30s while there are running jobs
  useEffect(() => {
    const hasRunning = jobs.some(j => j.status === "running" || j.status === "pending");
    if (!hasRunning) return;
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [jobs, load]);

  const total    = stats ? Number(stats.total_jobs)    : jobs.length;
  const done     = stats ? Number(stats.done_jobs)     : jobs.filter(j => j.status === "done").length;
  const suspects = stats ? Number(stats.clone_suspect) : jobs.filter(j => (j.similarity_score ?? 0) >= 0.95).length;
  const providers = stats
    ? Number(stats.unique_providers)
    : new Set(jobs.map(j => j.model_name?.split("/")[0] ?? "unknown")).size;
  const running  = jobs.filter(j => j.status === "running" || j.status === "pending").length;

  const recent = jobs.slice(0, 6);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Dashboard"
        icon={Fingerprint}
        subtitle="Overview of all model fingerprint activity"
        action={
          <Link
            href="/fingerprint"
            className="rounded bg-accent px-3 py-1.5 text-[13px] font-[510] text-white hover:bg-accent-hover transition-colors whitespace-nowrap"
          >
            + Fingerprint a Model
          </Link>
        }
      />

      {/* Stats row — clickable */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 mb-6 sm:mb-8">
        <ClickableStatCard
          label="Models Fingerprinted" value={loading ? "—" : total}
          icon={Fingerprint} accent
          onClick={() => setDrill("fingerprinted")}
        />
        <ClickableStatCard
          label="Unique Providers" value={loading ? "—" : providers}
          icon={Layers}
          onClick={() => setDrill("providers")}
        />
        <ClickableStatCard
          label="Clone Suspects" value={loading ? "—" : suspects}
          icon={AlertTriangle} accent={suspects > 0}
          onClick={() => setDrill("suspects")}
        />
        <ClickableStatCard
          label={running > 0 ? `Running (${running})` : "Pending Approvals"}
          value={loading ? "—" : running > 0 ? running : pendingCount}
          icon={Clock} accent={running > 0 || pendingCount > 0}
          onClick={() => running > 0 ? setDrill("pending") : undefined}
        />
      </div>

      {/* Charts + activity */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Similarity chart */}
        <div className="lg:col-span-3 rounded-md border border-white/6 bg-white/[0.02] p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[14px] font-[590] text-text-primary" style={{ letterSpacing: "-0.182px" }}>
              Similarity Scores
            </h2>
            {loading ? <Skeleton className="h-4 w-40" /> : <StatusDonutRow jobs={jobs} />}
          </div>
          {loading
            ? <div className="h-[220px] flex items-center justify-center"><Skeleton className="h-32 w-full" /></div>
            : <SimilarityBarChart jobs={jobs} />
          }
          <p className="mt-3 text-[11px] text-text-subtle">
            ≥95% = Clone Suspect &nbsp;·&nbsp; ≥85% = High &nbsp;·&nbsp; ≥70% = Same Family
          </p>
        </div>

        {/* Activity feed */}
        <div className="lg:col-span-2 rounded-md border border-white/6 bg-white/[0.02] p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[14px] font-[590] text-text-primary" style={{ letterSpacing: "-0.182px" }}>
              Recent Jobs
            </h2>
            <Link
              href="/jobs"
              className="flex items-center gap-1 text-[12px] text-text-muted hover:text-text-secondary transition-colors"
            >
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>

          {loading ? (
            <div className="space-y-2">
              {[0,1,2,3,4].map(i => <Skeleton key={i} className="h-12 w-full rounded" />)}
            </div>
          ) : recent.length === 0 ? (
            <EmptyState
              title="No jobs yet"
              description="Submit a model to start fingerprinting"
              icon={Fingerprint}
            />
          ) : (
            <div className="space-y-1.5">
              {recent.map((job, i) => (
                <button
                  key={job.job_id}
                  onClick={() => setSelectedJob(job)}
                  className="w-full flex items-center justify-between rounded border border-white/4 bg-white/[0.015] px-3 py-2.5 transition-all duration-150 hover:bg-white/[0.035] hover:border-white/8 text-left animate-fade-in"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <div className="min-w-0 pr-2">
                    <p className="truncate text-[13px] font-[510] text-text-secondary">
                      {job.model_name ?? "Unknown"}
                    </p>
                    <p className="text-[11px] text-text-subtle font-mono">
                      {job.job_id?.slice(0, 8)}…
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {statusBadge(job.status)}
                    {job.similarity_score != null && (
                      <SimilarityMeter value={job.similarity_score} showLabel={false} />
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {pendingCount > 0 && (
            <Link
              href="/approvals"
              className="mt-4 flex items-center justify-between rounded border border-warning/15 bg-warning/[0.04] px-3 py-2.5 text-[13px] text-warning hover:bg-warning/[0.07] transition-colors"
            >
              <span className="flex items-center gap-2">
                <Clock className="h-3.5 w-3.5" />
                {pendingCount} pending approval{pendingCount > 1 ? "s" : ""}
              </span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
      </div>

      {/* Drill-down modal */}
      {drill && (
        <DrillModal
          filter={drill}
          jobs={jobs}
          loading={loading}
          onClose={() => setDrill(null)}
          onSelectJob={(job) => { setDrill(null); setSelectedJob(job); }}
        />
      )}

      {/* Job detail drawer */}
      {selectedJob && (
        <JobDetailSheet job={selectedJob} onClose={() => setSelectedJob(null)} />
      )}
    </div>
  );
}
