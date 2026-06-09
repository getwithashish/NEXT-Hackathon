import express from "express";
import { start, getRun, resumeHook } from "workflow/api";
import { contentReviewWorkflow } from "../workflows/content-review.js";

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// POST /api/submit — start a new content review workflow
app.post("/api/submit", async (req, res) => {
  const { content, author } = req.body || {};
  if (!content) return res.status(400).json({ error: "content is required" });

  const jobId = crypto.randomUUID().slice(0, 8);
  const run = await start(contentReviewWorkflow, [jobId, content, author ?? "Anonymous"]);

  return res.json({ jobId, runId: run.runId, status: "started" });
});

// GET /api/status/:runId — poll workflow status
app.get("/api/status/:runId", async (req, res) => {
  try {
    const run = getRun(req.params.runId);
    const status = await run.status;
    let result = null;
    if (status === "completed" || status === "failed") {
      result = await run.returnValue;
    }
    return res.json({ runId: req.params.runId, status, result });
  } catch (err: any) {
    return res.status(404).json({ error: err.message });
  }
});

// POST /api/decide/:jobId — human approve or reject (resumes HIL hook)
app.post("/api/decide/:jobId", async (req, res) => {
  const { approved, note } = req.body || {};
  const token = `review:${req.params.jobId}`;

  try {
    const result = await resumeHook(token, {
      approved: !!approved,
      note: note || (approved ? "Approved ✓" : "Rejected by reviewer"),
    });
    return res.json({ ok: true, runId: result.runId });
  } catch (err: any) {
    return res.status(404).json({ error: `Hook not found: ${err.message}` });
  }
});

// Health check
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

export default app;
