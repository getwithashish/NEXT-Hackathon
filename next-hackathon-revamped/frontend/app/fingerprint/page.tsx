"use client";
import { useState, useRef, useEffect } from "react";
import { submitFingerprint, getWorkflowStatus } from "../../lib/api";

// Step definitions — these map to the workflow steps by name in step_events
const STEPS = [
  { id: "resolve-template",     label: "Resolve Template",  icon: "📋" },
  { id: "fingerprint-batch-0",  label: "Prompts 1–5",       icon: "🔬" },
  { id: "fingerprint-batch-1",  label: "Prompts 6–10",      icon: "🔬" },
  { id: "fingerprint-batch-2",  label: "Prompts 11–15",     icon: "🔬" },
  { id: "compare-and-persist",  label: "Compare & Save",    icon: "📊" },
];

type StepState = "pending" | "running" | "done" | "failed";
type RunStatus = { run_id: string; status: string; step_events: any[]; result?: any };

function StepIndicator({ label, icon, state, detail }: { label: string; icon: string; state: StepState; detail?: string }) {
  const colors: Record<StepState, string> = {
    pending: "#444",
    running: "#f59e0b",
    done: "#22c55e",
    failed: "#ef4444",
  };
  const labels: Record<StepState, string> = {
    pending: "Pending",
    running: "Running…",
    done: "Done",
    failed: "Failed",
  };
  const bg = state === "running" ? "#1e1e3e" : "#1a1a2e";
  const border = state === "running" ? "1px solid #f59e0b" : state === "done" ? "1px solid #22c55e" : "1px solid transparent";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderRadius: 10, background: bg, marginBottom: 8, border }}>
      <span style={{ fontSize: 20 }}>{icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, color: "#e0e0ff" }}>{label}</div>
        {detail && <div style={{ fontSize: 12, color: "#999", marginTop: 2 }}>{detail}</div>}
      </div>
      <span style={{ color: colors[state], fontSize: 12, fontWeight: 700 }}>{labels[state]}</span>
    </div>
  );
}

function deriveStepStates(stepEvents: any[], overallStatus: string): Record<string, StepState> {
  // Build state map from REAL step events emitted by getRun().readable
  const state: Record<string, StepState> = {};
  STEPS.forEach(s => { state[s.id] = "pending"; });

  for (const ev of stepEvents) {
    if (ev.type === "step_started" && ev.step_name) {
      state[ev.step_name] = "running";
    } else if (ev.type === "step_completed" && ev.step_name) {
      state[ev.step_name] = "done";
    } else if (ev.type === "step_failed" && ev.step_name) {
      state[ev.step_name] = "failed";
    }
  }

  if (overallStatus === "completed") {
    STEPS.forEach(s => { if (state[s.id] !== "failed") state[s.id] = "done"; });
  }

  return state;
}

export default function FingerprintPage() {
  const [apiEndpoint, setApiEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelHint, setModelHint] = useState("");
  const [docUrl, setDocUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const pollerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollerRef.current) { clearInterval(pollerRef.current); pollerRef.current = null; }
  }

  useEffect(() => () => stopPolling(), []);

  async function startPolling(runId: string) {
    stopPolling();
    pollerRef.current = setInterval(async () => {
      try {
        const data = await getWorkflowStatus(runId);
        setRunStatus(data);
        if (data.status === "completed" || data.status === "failed") {
          stopPolling();
        }
      } catch (e: any) {
        console.error("Poll error:", e.message);
      }
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

  const stepStates = runStatus ? deriveStepStates(runStatus.step_events, runStatus.status) : {};

  return (
    <div>
      <h2 style={{ color: "#6366f1" }}>🔍 Fingerprint a Model</h2>
      <form onSubmit={handleSubmit} style={{ background: "#1a1a2e", padding: 24, borderRadius: 12, marginBottom: 24 }}>
        <div style={{ display: "grid", gap: 12 }}>
          <label style={{ color: "#a0a0cc", fontSize: 13 }}>API Endpoint *
            <input required value={apiEndpoint} onChange={e => setApiEndpoint(e.target.value)}
              placeholder="https://api.openai.com/v1"
              style={{ display: "block", width: "100%", marginTop: 4, padding: "8px 12px", background: "#0f0f1a", border: "1px solid #2a2a4e", borderRadius: 6, color: "#e0e0ff", fontSize: 14, boxSizing: "border-box" }} />
          </label>
          <label style={{ color: "#a0a0cc", fontSize: 13 }}>API Key *
            <input required type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
              placeholder="sk-..."
              style={{ display: "block", width: "100%", marginTop: 4, padding: "8px 12px", background: "#0f0f1a", border: "1px solid #2a2a4e", borderRadius: 6, color: "#e0e0ff", fontSize: 14, boxSizing: "border-box" }} />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ color: "#a0a0cc", fontSize: 13 }}>Model Name
              <input value={modelName} onChange={e => setModelName(e.target.value)}
                placeholder="e.g. gpt-4o"
                style={{ display: "block", width: "100%", marginTop: 4, padding: "8px 12px", background: "#0f0f1a", border: "1px solid #2a2a4e", borderRadius: 6, color: "#e0e0ff", fontSize: 14, boxSizing: "border-box" }} />
            </label>
            <label style={{ color: "#a0a0cc", fontSize: 13 }}>Model Hint
              <input value={modelHint} onChange={e => setModelHint(e.target.value)}
                placeholder="e.g. gpt-4o-mini"
                style={{ display: "block", width: "100%", marginTop: 4, padding: "8px 12px", background: "#0f0f1a", border: "1px solid #2a2a4e", borderRadius: 6, color: "#e0e0ff", fontSize: 14, boxSizing: "border-box" }} />
            </label>
          </div>
          <label style={{ color: "#a0a0cc", fontSize: 13 }}>Provider Docs URL (optional — AI extracts the request format)
            <input value={docUrl} onChange={e => setDocUrl(e.target.value)}
              placeholder="https://docs.provider.com/api-reference"
              style={{ display: "block", width: "100%", marginTop: 4, padding: "8px 12px", background: "#0f0f1a", border: "1px solid #2a2a4e", borderRadius: 6, color: "#e0e0ff", fontSize: 14, boxSizing: "border-box" }} />
          </label>
          <button type="submit" disabled={loading}
            style={{ background: loading ? "#3b3b6e" : "#6366f1", color: "#fff", padding: "10px 24px", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 15, cursor: loading ? "not-allowed" : "pointer", marginTop: 4 }}>
            {loading ? "Starting…" : "Start Fingerprinting"}
          </button>
        </div>
      </form>

      {error && <div style={{ background: "#3b0000", border: "1px solid #ef4444", borderRadius: 8, padding: 12, color: "#fca5a5", marginBottom: 16 }}>❌ {error}</div>}

      {runStatus && (
        <div>
          <h3 style={{ color: "#e0e0ff" }}>Workflow Progress</h3>
          <div style={{ marginBottom: 8, fontSize: 13, color: "#666" }}>Run ID: {runStatus.run_id} · Status: <span style={{ color: runStatus.status === "completed" ? "#22c55e" : runStatus.status === "failed" ? "#ef4444" : "#f59e0b", fontWeight: 700 }}>{runStatus.status}</span></div>
          {STEPS.map(step => (
            <StepIndicator key={step.id} label={step.label} icon={step.icon} state={stepStates[step.id] ?? "pending"} />
          ))}
          {runStatus.status === "completed" && runStatus.result && (
            <div style={{ background: "#0a1f0a", border: "1px solid #22c55e", borderRadius: 8, padding: 16, marginTop: 16 }}>
              <h4 style={{ color: "#22c55e", margin: "0 0 12px" }}>✅ Result</h4>
              <div><strong>Verdict:</strong> <span style={{ color: "#6366f1", fontWeight: 700 }}>{runStatus.result.verdict}</span></div>
              <div style={{ marginTop: 8 }}><strong>Behavior Hash:</strong> <code style={{ fontSize: 11, color: "#a0a0cc" }}>{runStatus.result.behavior_hash}</code></div>
              {runStatus.result.similar_models?.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <strong>Similar Models:</strong>
                  <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                    {runStatus.result.similar_models.map((m: any, i: number) => (
                      <li key={i} style={{ color: "#a0a0cc", fontSize: 13 }}>
                        {m.name} ({m.source}) — similarity: {(m.similarity * 100).toFixed(1)}%
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
