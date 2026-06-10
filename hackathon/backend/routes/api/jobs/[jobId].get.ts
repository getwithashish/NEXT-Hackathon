/**
 * GET /api/jobs/:jobId
 * Returns a single fingerprint job by job_id.
 * Excludes embedding_vectors and mean_vector (large float arrays).
 */
import { defineEventHandler, setHeader, getRouterParam } from "h3";
import { getRawSql } from "../../../lib/db/index";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  setHeader(event, "Cache-Control", "no-store");

  const jobId = getRouterParam(event, "jobId");
  if (!jobId) {
    event.node.res.statusCode = 400;
    return { error: "jobId required" };
  }

  const sql = getRawSql();

  const rows = (await sql`
    SELECT job_id, workflow_run_id, model_name, model_type, status, source,
           verdict, similarity_score, matched_model, fingerprint_hash,
           fingerprint_data, error_message, api_endpoint, step_events,
           created_at, completed_at
    FROM fingerprints
    WHERE job_id = ${jobId}
    LIMIT 1
  `) as any[];

  if (!rows || rows.length === 0) {
    event.node.res.statusCode = 404;
    return { error: "not found" };
  }

  return rows[0];
});
