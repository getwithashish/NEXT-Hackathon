import Link from "next/link";
import { Fingerprint, Layers, AlertTriangle, Clock, ArrowRight } from "lucide-react";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { SimilarityBarChart, StatusDonutRow } from "@/components/Charts";
import { statusBadge } from "@/components/Badge";
import { SimilarityMeter } from "@/components/SimilarityMeter";
import { EmptyState } from "@/components/EmptyState";

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://backend-three-zeta-94.vercel.app";

async function getJobs() {
  try {
    const res = await fetch(`${API}/api/jobs`, { next: { revalidate: 30 } });
    if (!res.ok) return [];
    const data = await res.json();
    return data.jobs ?? [];
  } catch { return []; }
}

async function getPendingCount() {
  try {
    const res = await fetch(`${API}/api/approval/pending`, { next: { revalidate: 30 } });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.pending?.length ?? 0;
  } catch { return 0; }
}

export default async function DashboardPage() {
  const [jobs, pendingCount] = await Promise.all([getJobs(), getPendingCount()]);

  const total = jobs.length;
  const suspects = jobs.filter((j: any) => (j.similarity_score ?? 0) >= 0.90).length;
  const providers = new Set(jobs.map((j: any) => j.provider_name ?? "unknown")).size;
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

      {/* Stats row — 2 cols on mobile, 4 on desktop */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 mb-6 sm:mb-8">
        <StatCard label="Models Fingerprinted" value={total} icon={Fingerprint} accent />
        <StatCard label="Unique Providers" value={providers} icon={Layers} />
        <StatCard
          label="Clone Suspects"
          value={suspects}
          icon={AlertTriangle}
          accent={suspects > 0}
        />
        <StatCard
          label="Pending Approvals"
          value={pendingCount}
          icon={Clock}
          accent={pendingCount > 0}
        />
      </div>

      {/* Charts + activity — stacked on mobile, 5-col grid on large */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Similarity chart */}
        <div className="lg:col-span-3 rounded-md border border-white/8 bg-white/[0.02] p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[14px] font-[590] text-text-primary" style={{ letterSpacing: "-0.182px" }}>
              Similarity Scores
            </h2>
            <StatusDonutRow jobs={jobs} />
          </div>
          <SimilarityBarChart jobs={jobs} />
          <p className="mt-3 text-[11px] text-text-subtle">
            ≥90% = Clone Suspect &nbsp;·&nbsp; ≥75% = High &nbsp;·&nbsp; ≥50% = Moderate
          </p>
        </div>

        {/* Activity feed */}
        <div className="lg:col-span-2 rounded-md border border-white/8 bg-white/[0.02] p-4 sm:p-5">
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

          {recent.length === 0 ? (
            <EmptyState
              title="No jobs yet"
              description="Submit a model to start fingerprinting"
              icon={Fingerprint}
            />
          ) : (
            <div className="space-y-2">
              {recent.map((job: any, i: number) => (
                <div
                  key={job.job_id ?? i}
                  className="flex items-center justify-between rounded border border-white/5 bg-white/[0.02] px-3 py-2.5 transition-colors hover:bg-white/[0.04] animate-fade-in"
                  style={{ animationDelay: `${i * 50}ms` }}
                >
                  <div className="min-w-0 pr-2">
                    <p className="truncate text-[13px] font-[510] text-text-secondary">
                      {job.model_name ?? job.provider_name ?? "Unknown"}
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
                </div>
              ))}
            </div>
          )}

          {pendingCount > 0 && (
            <Link
              href="/approvals"
              className="mt-4 flex items-center justify-between rounded border border-warning/20 bg-warning/5 px-3 py-2.5 text-[13px] text-warning hover:bg-warning/10 transition-colors"
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
    </div>
  );
}
