"use client";

import { useState } from "react";
import { CheckCircle2, Circle, Loader2, AlertCircle, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { SimilarityMeter } from "@/components/SimilarityMeter";
import { CopyButton } from "@/components/CopyButton";

const STEPS = [
  { key: "probe",   label: "Probing model endpoints" },
  { key: "hash",    label: "Computing fingerprint hash" },
  { key: "compare", label: "Comparing against known models" },
  { key: "store",   label: "Storing result" },
];

interface WorkflowResult {
  job_id: string;
  run_id: string;
  fingerprint_hash?: string;
  similarity_score?: number;
  matched_model?: string;
  status: string;
}

interface WorkflowProgressProps {
  runId: string;
  jobId: string;
  onDone?: (result: WorkflowResult) => void;
}

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://backend-three-zeta-94.vercel.app";

export function WorkflowProgress({ runId, jobId, onDone }: WorkflowProgressProps) {
  // Poll for job status
  const [stepIdx, setStepIdx] = useState(0);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const [result, setResult] = useState<WorkflowResult | null>(null);

  // Poll on mount
  if (typeof window !== "undefined" && !done && !failed) {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API}/api/jobs/${jobId}`);
        if (!res.ok) return;
        const data = await res.json();
        const job = data.job;

        // Advance step indicator based on status
        if (job.status === "running" && stepIdx < 3) setStepIdx((s) => Math.min(s + 1, 2));
        if (job.status === "done") {
          setStepIdx(4);
          setDone(true);
          setResult({ job_id: jobId, run_id: runId, ...job });
          onDone?.({ job_id: jobId, run_id: runId, ...job });
          clearInterval(interval);
        }
        if (job.status === "failed") {
          setFailed(true);
          clearInterval(interval);
        }
      } catch {}
    }, 2500);

    // Advance animation even without data
    const anim = setTimeout(() => {
      if (!done && !failed) setStepIdx((s) => Math.min(s + 1, 2));
    }, 4000);

    return () => { clearInterval(interval); clearTimeout(anim); };
  }

  return (
    <div className="mt-6 rounded-md border border-white/8 bg-white/[0.02] p-5 animate-fade-in">
      <h3 className="mb-4 text-[13px] font-[590] text-text-secondary">
        Workflow Running
        <span className="ml-2 font-mono text-[11px] text-text-subtle">run:{runId.slice(5, 13)}</span>
      </h3>

      <div className="space-y-3">
        {STEPS.map((step, i) => {
          const isActive  = i === stepIdx && !done && !failed;
          const isDone    = done || i < stepIdx;
          const isPending = !done && !failed && i > stepIdx;

          return (
            <div key={step.key} className="flex items-center gap-3" style={{ animationDelay: `${i * 80}ms` }}>
              <div className="shrink-0">
                {failed && i === stepIdx ? (
                  <AlertCircle className="h-4 w-4 text-danger" />
                ) : isDone ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                ) : isActive ? (
                  <Loader2 className="h-4 w-4 animate-spin text-accent-bright" />
                ) : (
                  <Circle className="h-4 w-4 text-text-subtle" />
                )}
              </div>
              <span className={cn(
                "text-[13px]",
                isDone    ? "text-text-secondary" :
                isActive  ? "text-text-primary font-[510]" :
                "text-text-subtle"
              )}>
                {step.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Result card */}
      {done && result && (
        <div className="mt-5 rounded border border-success/20 bg-success/5 p-4 animate-fade-in">
          <div className="mb-3 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-success" />
            <span className="text-[13px] font-[590] text-success">Fingerprint Complete</span>
          </div>

          {result.fingerprint_hash && (
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[11px] text-text-subtle w-24 shrink-0">Hash</span>
              <span className="font-mono text-[12px] text-text-muted truncate">{result.fingerprint_hash.slice(0, 32)}…</span>
              <CopyButton value={result.fingerprint_hash} />
            </div>
          )}

          {result.similarity_score != null && (
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[11px] text-text-subtle w-24 shrink-0">Similarity</span>
              <SimilarityMeter value={result.similarity_score} />
            </div>
          )}

          {result.matched_model && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-text-subtle w-24 shrink-0">Closest match</span>
              <span className="text-[13px] text-text-secondary">{result.matched_model}</span>
            </div>
          )}

          <a
            href={`/jobs`}
            className="mt-3 flex items-center gap-1 text-[12px] text-accent-bright hover:text-accent-hover"
          >
            View all jobs <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}

      {failed && (
        <div className="mt-4 rounded border border-danger/20 bg-danger/5 px-4 py-3 text-[13px] text-danger animate-fade-in">
          Workflow failed. Check the job details for more info.
        </div>
      )}
    </div>
  );
}
