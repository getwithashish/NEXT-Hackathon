"use client";

import { useState, useEffect, useCallback } from "react";
import { Clock, Eye, EyeOff, CheckCircle2, XCircle, RefreshCw, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton, SkeletonCard } from "@/components/Skeleton";
import { cn } from "@/lib/utils";
import { getPendingApprovals, decideApproval } from "@/lib/api";

function fmt(dateStr: string) {
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)   return "just now";
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function ApprovalCard({
  provider,
  onDecide,
}: {
  provider: any;
  onDecide: (id: string, approved: boolean, apiKey: string) => Promise<void>;
}) {
  const [apiKey,   setApiKey]   = useState("");
  const [showKey,  setShowKey]  = useState(false);
  const [loading,  setLoading]  = useState<"approve" | "skip" | null>(null);
  const [done,     setDone]     = useState<"approved" | "skipped" | null>(null);
  const [err,      setErr]      = useState<string | null>(null);

  async function decide(approved: boolean) {
    if (approved && !apiKey.trim()) { setErr("API key is required to approve"); return; }
    setErr(null);
    setLoading(approved ? "approve" : "skip");
    try {
      await onDecide(provider.id, approved, apiKey);
      setDone(approved ? "approved" : "skipped");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(null);
    }
  }

  if (done) {
    return (
      <div className={cn(
        "rounded-md border p-5 flex items-center gap-3 animate-fade-in",
        done === "approved"
          ? "border-success/20 bg-success/5"
          : "border-white/6 bg-white/[0.02]"
      )}>
        {done === "approved"
          ? <CheckCircle2 className="h-5 w-5 text-success shrink-0" />
          : <XCircle className="h-5 w-5 text-text-subtle shrink-0" />}
        <div>
          <p className="text-[14px] font-[510] text-text-secondary">{provider.name}</p>
          <p className={cn("text-[12px]", done === "approved" ? "text-success" : "text-text-subtle")}>
            {done === "approved" ? "Approved — fingerprint workflow starting…" : "Skipped"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="surface-card hairline-top p-5 space-y-4 transition-all hover:border-white/[0.10] hover:shadow-elevation-high">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[15px] font-[590] text-text-primary" style={{ letterSpacing: "-0.18px" }}>
            {provider.name}
          </h3>
          <p className="mt-0.5 text-[12px] text-text-subtle">{fmt(provider.discovered_at)}</p>
        </div>
        <span className="shrink-0 rounded-full border border-warning/25 bg-warning/10 px-2 py-0.5 text-[11px] font-[510] text-warning">
          Pending
        </span>
      </div>

      {/* Links */}
      <div className="flex flex-wrap gap-3">
        {provider.docs_url && (
          <a
            href={provider.docs_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[12px] text-accent-bright hover:text-accent-hover transition-colors"
          >
            Docs <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {provider.pricing_url && (
          <a
            href={provider.pricing_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[12px] text-text-muted hover:text-text-secondary transition-colors"
          >
            Pricing <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {/* API Key input */}
      <div className="space-y-1.5">
        <label className="block text-[12px] font-[510] text-text-secondary">
          API Key <span className="text-text-subtle">(required to approve)</span>
        </label>
        <div className="relative">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="w-full rounded border border-white/6 bg-bg-panel px-3 py-2 pr-10 font-mono text-[13px] text-text-primary placeholder-text-subtle focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/10 transition-colors"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-subtle hover:text-text-muted transition-colors"
          >
            {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Error */}
      {err && (
        <p className="text-[12px] text-danger animate-fade-in">{err}</p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => decide(true)}
          disabled={!!loading}
          className={cn(
            "flex-1 rounded py-2 text-[13px] font-[590] text-white transition-all",
            loading === "approve"
              ? "cursor-not-allowed bg-success/50"
              : "bg-success hover:bg-success/80 active:scale-[0.98]"
          )}
        >
          {loading === "approve" ? "Approving…" : "Approve & Fingerprint"}
        </button>
        <button
          onClick={() => decide(false)}
          disabled={!!loading}
          className={cn(
            "rounded border border-white/6 px-4 py-2 text-[13px] font-[510] transition-colors",
            loading === "skip"
              ? "cursor-not-allowed text-text-subtle"
              : "text-text-muted hover:bg-white/5 hover:text-text-secondary"
          )}
        >
          {loading === "skip" ? "Skipping…" : "Skip"}
        </button>
      </div>
    </div>
  );
}

export default function ApprovalsPage() {
  const [providers, setProviders] = useState<any[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await getPendingApprovals();
      setProviders(data.pending ?? []);
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    if (!autoRefresh) return;
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load, autoRefresh]);

  async function handleDecide(id: string, approved: boolean, apiKey: string) {
    const { decideApproval: decide } = await import("@/lib/api");
    await decide(id, approved, apiKey);
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Pending Approvals"
        subtitle="Providers discovered by the crawler — approve with an API key to start fingerprinting"
        icon={Clock}
        action={
          <div className="flex flex-wrap items-center gap-3">
            {/* Auto-refresh toggle */}
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-text-muted select-none">
              <div
                onClick={() => setAutoRefresh((v) => !v)}
                className={cn(
                  "relative h-5 w-9 rounded-full border transition-colors",
                  autoRefresh ? "border-accent/30 bg-accent/20" : "border-white/6 bg-white/5"
                )}
              >
                <div className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full transition-all",
                  autoRefresh
                    ? "left-[calc(100%-18px)] bg-accent-bright"
                    : "left-0.5 bg-text-subtle"
                )} />
              </div>
              Auto-refresh (10s)
            </label>

            <button
              onClick={load}
              disabled={loading}
              className="flex items-center gap-1.5 rounded border border-white/6 bg-white/[0.02] px-3 py-1.5 text-[13px] text-text-muted hover:bg-white/[0.04] hover:text-text-secondary transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </button>
          </div>
        }
      />

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : providers.length === 0 ? (
        <div className="surface-card">
          <EmptyState
            icon={Clock}
            title="No pending approvals"
            description="The crawler will discover new providers automatically every 4 hours."
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {providers.map((p) => (
            <ApprovalCard key={p.id} provider={p} onDecide={handleDecide} />
          ))}
        </div>
      )}

      {/* Crawler info */}
      <div className="mt-8 rounded-md border border-white/5 bg-white/[0.015] px-4 py-3">
        <p className="text-[12px] text-text-subtle">
          Crawler runs every 4 hours on EC2. Discovers new providers via Exa search, then queues them here for your approval before any API keys are used.
        </p>
      </div>
    </div>
  );
}
