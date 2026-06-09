"use client";
import { useState, useEffect, useRef } from "react";

const API = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

interface WorkflowRun {
  jobId: string;
  runId: string;
  wfStatus: "started" | "running" | "completed" | "failed";
  result?: {
    status: string;
    validation?: { wordCount: number; charCount: number };
    moderation?: { passed: boolean; flaggedWords: string[]; confidenceScore: number };
    decision?: { approved: boolean; note: string };
    publish?: { published: boolean; slug?: string; url?: string; publishedAt?: string; reason?: string };
    reason?: string;
  };
  startedAt: number;
  decidedAt?: number;
}

type StepStatus = "pending" | "running" | "done" | "failed" | "waiting";

function Step({ name, icon, status, detail }: { name: string; icon: string; status: StepStatus; detail?: string }) {
  const colors: Record<StepStatus, string> = {
    pending: "#444", running: "#f59e0b", waiting: "#6366f1", done: "#22c55e", failed: "#ef4444",
  };
  const labels: Record<StepStatus, string> = {
    pending: "Pending", running: "Running", waiting: "Waiting", done: "Done", failed: "Failed",
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderRadius: 10, background: "#1a1a2e", marginBottom: 8, border: status === "waiting" ? "1px solid #6366f1" : "1px solid transparent" }}>
      <span style={{ fontSize: 20 }}>{icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, color: "#e0e0ff" }}>{name}</div>
        {detail && <div style={{ fontSize: 12, color: "#999", marginTop: 2 }}>{detail}</div>}
      </div>
      <span style={{ color: colors[status], fontSize: 12, fontWeight: 700 }}>{labels[status]}</span>
    </div>
  );
}

function deriveSteps(run: WorkflowRun): { validate: StepStatus; moderate: StepStatus; review: StepStatus; publish: StepStatus } {
  if (run.wfStatus === "completed" && run.result) {
    return { validate: "done", moderate: "done", review: run.result.decision ? "done" : "done", publish: run.result.publish?.published ? "done" : "failed" };
  }
  const elapsed = (Date.now() - run.startedAt) / 1000;
  if (run.decidedAt) return { validate: "done", moderate: "done", review: "done", publish: "running" };
  if (elapsed < 2) return { validate: "running", moderate: "pending", review: "pending", publish: "pending" };
  if (elapsed < 4) return { validate: "done", moderate: "running", review: "pending", publish: "pending" };
  return { validate: "done", moderate: "done", review: "waiting", publish: "pending" };
}

export default function Home() {
  const [content, setContent] = useState("");
  const [author, setAuthor] = useState("Ashish");
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [reviewNote, setReviewNote] = useState<Record<string, string>>({});
  const pollers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const t = setInterval(() => forceUpdate(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  function startPolling(runId: string) {
    if (pollers.current[runId]) return;
    pollers.current[runId] = setInterval(async () => {
      try {
        const res = await fetch(`${API}/api/status/${runId}`);
        const data = await res.json();
        setRuns(prev => prev.map(r => r.runId === runId ? { ...r, wfStatus: data.status, result: data.result } : r));
        if (data.status === "completed" || data.status === "failed") {
          clearInterval(pollers.current[runId]);
          delete pollers.current[runId];
        }
      } catch {}
    }, 2000);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, author }),
      });
      const data = await res.json();
      setRuns(prev => [{ jobId: data.jobId, runId: data.runId, wfStatus: "started", startedAt: Date.now() }, ...prev]);
      setContent("");
      startPolling(data.runId);
    } catch (err) { alert("Submit failed: " + err); }
    finally { setLoading(false); }
  }

  async function handleDecide(run: WorkflowRun, approved: boolean) {
    const note = reviewNote[run.jobId] || (approved ? "Approved" : "Rejected by reviewer");
    try {
      const res = await fetch(`${API}/api/decide/${run.jobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved, note }),
      });
      const data = await res.json();
      if (data.ok) setRuns(prev => prev.map(r => r.runId === run.runId ? { ...r, decidedAt: Date.now() } : r));
      else alert("Error: " + data.error);
    } catch (err) { alert("Decision failed: " + err); }
  }

  useEffect(() => () => { Object.values(pollers.current).forEach(clearInterval); }, []);

  return (
    <main style={{ minHeight: "100vh", background: "#0d0d1a", color: "#e0e0ff", fontFamily: "system-ui, sans-serif", padding: "40px 20px" }}>
      <style>{`* { box-sizing: border-box; } input,textarea { background:#1a1a2e;color:#e0e0ff;border:1px solid #333;border-radius:8px;padding:10px 14px;font-size:14px;width:100%; } input:focus,textarea:focus { outline:2px solid #6366f1;border-color:transparent; } button { cursor:pointer;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600; } button:disabled { opacity:.5;cursor:default; }`}</style>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div style={{ marginBottom: 32 }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: "0 0 8px" }}>Vercel Workflow SDK Demo</h1>
          <p style={{ color: "#888", margin: 0, fontSize: 14 }}>Durable multi-step workflow with Human-in-the-Loop pause/resume</p>
          <p style={{ color: "#555", margin: "4px 0 0", fontSize: 11 }}>Backend: {API}</p>
        </div>
        <form onSubmit={handleSubmit} style={{ background: "#13132a", borderRadius: 14, padding: 24, marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 16px", color: "#c0c0ff" }}>Submit Content for Review</h2>
          <input value={author} onChange={e => setAuthor(e.target.value)} placeholder="Author name" style={{ marginBottom: 12 }} />
          <textarea value={content} onChange={e => setContent(e.target.value)} placeholder={'Write content...\n\nTip: include "spam" to trigger auto-reject!'} rows={4} style={{ marginBottom: 16 }} />
          <button type="submit" disabled={loading || !content.trim()} style={{ background: "#6366f1", color: "#fff" }}>
            {loading ? "Starting..." : "Start Workflow"}
          </button>
        </form>
        {runs.length === 0 && (
          <div style={{ textAlign: "center", color: "#444", padding: 48, background: "#13132a", borderRadius: 14 }}>No workflows yet</div>
        )}
        {runs.map(run => {
          const steps = deriveSteps(run);
          const isAwaiting = steps.review === "waiting" && !run.decidedAt && run.wfStatus !== "completed";
          const isDone = run.wfStatus === "completed";
          const isFailed = run.wfStatus === "failed";
          return (
            <div key={run.runId} style={{ background: "#13132a", borderRadius: 14, padding: 24, marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <div>
                  <code style={{ fontSize: 13, color: "#6366f1" }}>Job {run.jobId}</code>
                  <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>{run.runId}</div>
                </div>
                <span style={{ padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700, textTransform: "uppercase",
                  background: isDone ? "#052e16" : isFailed ? "#450a0a" : isAwaiting ? "#1e1b4b" : "#1c1a10",
                  color: isDone ? "#4ade80" : isFailed ? "#f87171" : isAwaiting ? "#818cf8" : "#f59e0b" }}>
                  {isDone ? "Done" : isFailed ? "Failed" : isAwaiting ? "Awaiting Review" : "Running"}
                </span>
              </div>
              <Step name="1. Validate Input" icon="✅" status={steps.validate} detail={run.result?.validation ? `${run.result.validation.wordCount} words, ${run.result.validation.charCount} chars` : undefined} />
              <Step name="2. Auto-Moderate" icon="🤖" status={steps.moderate} detail={run.result?.moderation ? `Score ${run.result.moderation.confidenceScore} — ${run.result.moderation.passed ? "clean" : "flagged: " + run.result.moderation.flaggedWords.join(", ")}` : undefined} />
              <Step name="3. Human Review" icon="👤" status={steps.review} detail={run.result?.decision ? `${run.result.decision.approved ? "Approved" : "Rejected"}: ${run.result.decision.note}` : isAwaiting ? "Workflow paused — awaiting your decision" : run.decidedAt ? "Decision sent, resuming..." : undefined} />
              <Step name="4. Publish" icon="🚀" status={steps.publish} detail={run.result?.publish?.published ? `Published: ${run.result.publish.url}` : run.result?.publish?.reason || run.result?.reason} />
              {isAwaiting && (
                <div style={{ marginTop: 16, background: "#16153a", borderRadius: 12, padding: 16, border: "1px solid #3730a3" }}>
                  <div style={{ fontSize: 13, color: "#818cf8", fontWeight: 700, marginBottom: 12 }}>Human Review Required — Workflow is paused</div>
                  <input value={reviewNote[run.jobId] || ""} onChange={e => setReviewNote(prev => ({ ...prev, [run.jobId]: e.target.value }))} placeholder="Reviewer note (optional)" style={{ marginBottom: 10 }} />
                  <div style={{ display: "flex", gap: 10 }}>
                    <button onClick={() => handleDecide(run, true)} style={{ background: "#14532d", color: "#4ade80", flex: 1 }}>Approve & Publish</button>
                    <button onClick={() => handleDecide(run, false)} style={{ background: "#450a0a", color: "#f87171", flex: 1 }}>Reject</button>
                  </div>
                </div>
              )}
              {isDone && run.result && (
                <div style={{ marginTop: 12, padding: 14, borderRadius: 10, background: run.result.publish?.published ? "#052e16" : "#1c0505", fontSize: 14 }}>
                  {run.result.publish?.published
                    ? <><strong style={{ color: "#4ade80" }}>Published!</strong> <span style={{ color: "#777" }}>{run.result.publish.url}</span></>
                    : <><strong style={{ color: "#f87171" }}>Rejected:</strong> <span style={{ color: "#999" }}>{run.result.publish?.reason || run.result.reason}</span></>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}