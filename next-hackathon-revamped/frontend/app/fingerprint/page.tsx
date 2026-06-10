"use client";

import { useState, useRef, useEffect } from "react";
import { Eye, EyeOff, Fingerprint, ChevronDown, ChevronUp, Loader2, AlertCircle, CheckCircle2, Circle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { SimilarityMeter } from "@/components/SimilarityMeter";
import { CopyButton } from "@/components/CopyButton";
import { cn } from "@/lib/utils";
import { submitFingerprint, getWorkflowStatus } from "@/lib/api";

const STEPS = [
  { id: "resolve-template",    label: "Resolve probe template" },
  { id: "fingerprint-batch-0", label: "Probe batch 1 (prompts 1–5)" },
  { id: "fingerprint-batch-1", label: "Probe batch 2 (prompts 6–10)" },
  { id: "fingerprint-batch-2", label: "Probe batch 3 (prompts 11–15)" },
  { id: "embed-responses",     label: "Embed responses (Titan v2)" },
  { id: "compare-and-persist", label: "Compare & persist result" },
];

const PROVIDERS = [
  "openai", "anthropic", "cohere", "mistral", "together", "groq",
  "fireworks", "deepinfra", "perplexity", "anyscale", "custom",
];

type StepState = "pending" | "running" | "done" | "failed";

function deriveStepStates(events: any[], overallStatus: string): Record<string, StepState> {
  const state: Record<string, StepState> = {};
  STEPS.forEach((s) => { state[s.id] = "pending"; });
  for (const ev of events) {
    if (ev.type === "step_started"   && ev.step_name) state[ev.step_name] = "running";
    if (ev.type === "step_completed" && ev.step_name) state[ev.step_name] = "done";
    if (ev.type === "step_failed"    && ev.step_name) state[ev.step_name] = "failed";
  }
  if (overallStatus === "completed") STEPS.forEach((s) => { if (state[s.id] !== "failed") state[s.id] = "done"; });
  return state;
}

export default function FingerprintPage() {
  const [apiEndpoint, setApiEndpoint] = useState("");
  const [apiKey,      setApiKey]      = useState("");
  const [showKey,     setShowKey]     = useState(false);
  const [modelName,   setModelName]   = useState("");
  const [modelHint,   setModelHint]   = useState("");
  const [docUrl,      setDocUrl]      = useState("");
  const [showAdv,     setShowAdv]     = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [runStatus,   setRunStatus]   = useState<any>(null);
  const pollerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (pollerRef.current) clearInterval(pollerRef.current); }, []);

  async function startPolling(runId: string) {
    if (pollerRef.current) clearInterval(pollerRef.current);
    pollerRef.current = setInterval(async () => {
      try {
        const data = await getWorkflowStatus(runId);
        setRunStatus(data);
        if (data.status === "completed" || data.status === "failed") {
          clearInterval(pollerRef.current!);
          pollerRef.current = null;
        }
      } catch {}
    }, 2000);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRunStatus(null);
    setLoading(true);
    try {
      const res = await submitFingerprint({
        api_endpoint: apiEndpoint,
        api_key: apiKey,
        model_name: modelName || undefined,
        model_hint: modelHint || undefined,
        doc_url: docUrl || undefined,
      });
      setRunStatus({ run_id: res.run_id, status: "running", step_events: [] });
      await startPolling(res.run_id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const stepStates = runStatus ? deriveStepStates(runStatus.step_events ?? [], runStatus.status) : {};
  const isRunning   = runStatus?.status === "running";
  const isCompleted = runStatus?.status === "completed";
  const isFailed    = runStatus?.status === "failed";
  const result      = runStatus?.result;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Fingerprint a Model"
        subtitle="Probe any OpenAI-compatible API and detect if it's a clone or distilled model"
        icon={Fingerprint}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* Form — full width on mobile, 3 cols on lg */}
        <form
          onSubmit={handleSubmit}
          className="lg:col-span-3 rounded-md border border-white/6 bg-white/[0.02] p-4 sm:p-6 space-y-5"
        >
          {/* API Endpoint */}
          <div className="space-y-1.5">
            <label className="block text-[13px] font-[510] text-text-secondary">
              API Endpoint <span className="text-danger">*</span>
            </label>
            <input
              required
              value={apiEndpoint}
              onChange={(e) => setApiEndpoint(e.target.value)}
              placeholder="https://api.openai.com/v1"
              className="w-full rounded border border-white/6 bg-bg-panel px-3 py-2 text-[14px] text-text-primary placeholder-text-subtle transition-colors focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/20"
            />
          </div>

          {/* API Key */}
          <div className="space-y-1.5">
            <label className="block text-[13px] font-[510] text-text-secondary">
              API Key <span className="text-danger">*</span>
            </label>
            <div className="relative">
              <input
                required
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full rounded border border-white/6 bg-bg-panel px-3 py-2 pr-10 text-[14px] font-mono text-text-primary placeholder-text-subtle transition-colors focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/20"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-subtle hover:text-text-muted transition-colors"
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* Model Name */}
          <div className="space-y-1.5">
            <label className="block text-[13px] font-[510] text-text-secondary">Model Name</label>
            <input
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder="e.g. gpt-4o, claude-3-5-sonnet-20241022"
              className="w-full rounded border border-white/6 bg-bg-panel px-3 py-2 text-[14px] text-text-primary placeholder-text-subtle transition-colors focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/20"
            />
          </div>

          {/* Advanced toggle */}
          <button
            type="button"
            onClick={() => setShowAdv((v) => !v)}
            className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary transition-colors"
          >
            {showAdv ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            Advanced options
          </button>

          {showAdv && (
            <div className="space-y-4 border-t border-white/5 pt-4 animate-fade-in">
              <div className="space-y-1.5">
                <label className="block text-[13px] font-[510] text-text-secondary">Model Hint</label>
                <select
                  value={modelHint}
                  onChange={(e) => setModelHint(e.target.value)}
                  className="w-full rounded border border-white/6 bg-bg-panel px-3 py-2 text-[14px] text-text-primary transition-colors focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/20"
                >
                  <option value="">Select provider family…</option>
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="block text-[13px] font-[510] text-text-secondary">
                  Provider Docs URL
                  <span className="ml-1.5 text-[11px] text-text-subtle">AI extracts request format</span>
                </label>
                <input
                  value={docUrl}
                  onChange={(e) => setDocUrl(e.target.value)}
                  placeholder="https://docs.provider.com/api-reference"
                  className="w-full rounded border border-white/6 bg-bg-panel px-3 py-2 text-[14px] text-text-primary placeholder-text-subtle transition-colors focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/20"
                />
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 rounded border border-danger/20 bg-danger/5 px-3 py-2.5 text-[13px] text-danger animate-fade-in">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className={cn(
              "w-full rounded py-2.5 text-[14px] font-[590] text-white transition-all",
              loading
                ? "cursor-not-allowed bg-accent/50"
                : "bg-accent hover:bg-accent-hover active:scale-[0.98]"
            )}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Starting workflow…
              </span>
            ) : (
              "Start Fingerprinting"
            )}
          </button>
        </form>

        {/* Right panel — workflow progress + result */}
        <div className="lg:col-span-2 space-y-4">
          {/* How it works card (before run) */}
          {!runStatus && (
            <div className="rounded-md border border-white/6 bg-white/[0.02] p-5 animate-fade-in">
              <h3 className="mb-3 text-[13px] font-[590] text-text-secondary">How it works</h3>
              <ol className="space-y-2.5">
                {["Submit your model's API endpoint + key", "Agent probes with 15 behavioral prompts", "Fingerprint hash computed from responses", "Compared against 10+ known model signatures", "Verdict: Original / Similar / Clone Suspect"].map((s, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-[13px] text-text-muted">
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-[590] text-accent-bright">{i + 1}</span>
                    {s}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Workflow progress */}
          {runStatus && (
            <div className="rounded-md border border-white/6 bg-white/[0.02] p-5 animate-fade-in">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-[13px] font-[590] text-text-primary">Workflow Progress</h3>
                <span className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-[510]",
                  isCompleted ? "bg-success/15 text-success" :
                  isFailed    ? "bg-danger/15 text-danger" :
                  "bg-info/15 text-info"
                )}>
                  {runStatus.status}
                </span>
              </div>

              <div className="space-y-2.5">
                {STEPS.map((step, i) => {
                  const s = stepStates[step.id] ?? "pending";
                  return (
                    <div
                      key={step.id}
                      className="flex items-center gap-3"
                      style={{ animationDelay: `${i * 60}ms` }}
                    >
                      {s === "running" ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-info" />
                      ) : s === "done" ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                      ) : s === "failed" ? (
                        <AlertCircle className="h-4 w-4 shrink-0 text-danger" />
                      ) : (
                        <Circle className="h-4 w-4 shrink-0 text-text-subtle" />
                      )}
                      <span className={cn("text-[13px]",
                        s === "running" ? "font-[510] text-text-primary" :
                        s === "done"    ? "text-text-secondary" :
                        s === "failed"  ? "text-danger" :
                        "text-text-subtle"
                      )}>
                        {step.label}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 border-t border-white/5 pt-3">
                <p className="font-mono text-[11px] text-text-subtle">
                  run_id: {runStatus.run_id}
                </p>
              </div>
            </div>
          )}

          {/* Result card */}
          {isCompleted && result && (
            <div className="rounded-md border border-success/20 bg-success/5 p-5 animate-fade-in">
              <div className="mb-3 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-success" />
                <span className="text-[13px] font-[590] text-success">Result</span>
              </div>

              <div className="space-y-2.5">
                {result.verdict && (() => {
                  const verdictMeta: Record<string, { label: string; cls: string }> = {
                    exact_match:     { label: "Exact Match",        cls: "text-danger" },
                    clone_suspect:   { label: "Clone Suspect",      cls: "text-danger" },
                    high_similarity: { label: "High Similarity",    cls: "text-warning" },
                    same_family:     { label: "Same Family",        cls: "text-info" },
                    unknown:         { label: "Unknown / Original", cls: "text-success" },
                  };
                  const meta = verdictMeta[result.verdict] ?? { label: result.verdict, cls: "text-text-muted" };
                  return (
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] text-text-subtle">Verdict</span>
                      <span className={cn("text-[13px] font-[590]", meta.cls)}>{meta.label}</span>
                    </div>
                  );
                })()}

                {result.matched_model && (
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] text-text-subtle">Closest match</span>
                    <span className="text-[13px] font-[510] text-text-primary">{result.matched_model}</span>
                  </div>
                )}

                {result.similarity_score != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] text-text-subtle">Similarity</span>
                    <SimilarityMeter value={result.similarity_score} showLabel={false} />
                  </div>
                )}

                {result.behavior_hash && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] text-text-subtle shrink-0">Hash</span>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-[11px] text-text-muted truncate">
                        {result.behavior_hash.slice(0, 24)}…
                      </span>
                      <CopyButton value={result.behavior_hash} />
                    </div>
                  </div>
                )}

                {result.similar_models?.length > 0 && (
                  <div className="pt-2 border-t border-white/5">
                    <p className="mb-2 text-[12px] text-text-subtle">Similar models</p>
                    {result.similar_models.map((m: any, i: number) => (
                      <div key={i} className="flex items-center justify-between py-1.5">
                        <span className="text-[13px] text-text-secondary">{m.name}</span>
                        <SimilarityMeter value={m.similarity} showLabel={false} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {isFailed && (
            <div className="rounded-md border border-danger/20 bg-danger/5 p-4 animate-fade-in">
              <div className="flex items-center gap-2 text-[13px] text-danger">
                <AlertCircle className="h-4 w-4" />
                Workflow failed. Check console or try again.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
