/**
 * GET /api/jobs
 * Returns paginated fingerprint jobs.
 * Query params:
 *   limit  — page size (default 20, max 200)
 *   page   — 1-based page number (default 1)
 *   status — filter by status (e.g. "done", "running", "failed", "pending")
 *   verdict — filter by verdict (e.g. "clone_suspect", "high_similarity")
 */
import { defineEventHandler, setHeader, getQuery } from "h3";
import { getRawSql } from "../../../lib/db/index";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  setHeader(event, "Cache-Control", "no-store");

  const query = getQuery(event);
  const limit  = Math.min(Number(query.limit ?? 20), 200);
  const page   = Math.max(Number(query.page  ?? 1), 1);
  const offset = (page - 1) * limit;
  const status  = query.status  as string | undefined;
  const verdict = query.verdict as string | undefined;

  const sql = getRawSql();

  // Build WHERE clause
  const whereParts: string[] = [];
  if (status)  whereParts.push(`status = '${status.replace(/'/g, "''")}'`);
  if (verdict) whereParts.push(`verdict = '${verdict.replace(/'/g, "''")}'`);
  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  const [rows, countRows] = await Promise.all([
    sql.unsafe(`
      SELECT job_id, workflow_run_id, model_name, model_type, status, source,
             verdict, similarity_score, matched_model, fingerprint_hash,
             created_at, completed_at, step_events
      FROM fingerprints
      ${where}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
    sql.unsafe(`SELECT COUNT(*)::int AS total FROM fingerprints ${where}`),
  ]);

  const total = (countRows as any[])[0]?.total ?? 0;

  return {
    jobs:  rows as any[],
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
});
