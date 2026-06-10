/**
 * GET /api/fingerprint/status/:runId
 *
 * Returns live workflow progress by reading fingerprints.step_events from DB
 * (written by pushStepEvent inside each workflow step) plus the overall status.
 *
 * Falls back to getRun(runId).status from the workflow runtime for the status
 * field, but step events always come from DB — this is reliable and doesn't
 * race against the readable stream's 100ms window.
 *
 * Response shape:
 *   { run_id, status, step_events, result? }
 */
import { defineEventHandler, setHeader, getRouterParam } from "h3";
import { getRawSql } from "../../../lib/db/index";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  const runId = getRouterParam(event, "runId");
  if (!runId) {
    event.node.res.statusCode = 400;
    return { error: "runId required" };
  }

  const sql = getRawSql();

  // Look up the fingerprint row by workflow_run_id
  const rows = (await sql`
    SELECT status, step_events, fingerprint_data, verdict, similarity_score,
           matched_model, fingerprint_hash, job_id, completed_at
    FROM fingerprints
    WHERE workflow_run_id = ${runId}
    LIMIT 1
  `) as any[];

  if (!rows || rows.length === 0) {
    // Unknown run_id — may be too early (row not yet written) or invalid
    return { run_id: runId, status: "pending", step_events: [], result: null };
  }

  const row = rows[0];
  const stepEvents = Array.isArray(row.step_events) ? row.step_events : [];

  // Map DB status ("done" → "completed" for frontend compatibility)
  const status =
    row.status === "done" ? "completed" :
    row.status === "failed" ? "failed" :
    row.status === "running" ? "running" : "pending";

  let result = null;
  if (status === "completed") {
    const fd = row.fingerprint_data ?? {};
    result = {
      behavior_hash:    row.fingerprint_hash,
      verdict:          row.verdict ?? fd.verdict,
      similarity_score: row.similarity_score ?? fd.similarity_score,
      matched_model:    row.matched_model ?? fd.matched_model,
      similar_models:   fd.similar_models ?? [],
    };
  }

  return { run_id: runId, status, step_events: stepEvents, result };
});
