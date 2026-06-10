/**
 * GET /api/jobs
 * Returns paginated fingerprint jobs.
 * Query params:
 *   limit   — page size (default 20, max 200)
 *   page    — 1-based page number (default 1)
 *   status  — filter by status (e.g. "done", "running", "failed", "pending")
 *   verdict — filter by verdict (e.g. "clone_suspect", "high_similarity")
 */
import { defineEventHandler, setHeader, getQuery } from "h3";
import { db, fingerprints } from "../../../lib/db/index";
import { desc, eq, and, SQL } from "drizzle-orm";
import { getRawSql } from "../../../lib/db/index";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  setHeader(event, "Cache-Control", "no-store");

  const query  = getQuery(event);
  const limit  = Math.min(Number(query.limit ?? 20), 200);
  const page   = Math.max(Number(query.page  ?? 1), 1);
  const offset = (page - 1) * limit;
  const status  = query.status  as string | undefined;
  const verdict = query.verdict as string | undefined;

  // Build WHERE conditions
  const conditions: SQL[] = [];
  if (status  && status  !== "all") conditions.push(eq(fingerprints.status,  status));
  if (verdict && verdict !== "all") conditions.push(eq(fingerprints.verdict, verdict));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Run data + count queries in parallel
  const [jobs, countResult] = await Promise.all([
    db
      .select({
        job_id:           fingerprints.job_id,
        workflow_run_id:  fingerprints.workflow_run_id,
        model_name:       fingerprints.model_name,
        model_type:       fingerprints.model_type,
        status:           fingerprints.status,
        source:           fingerprints.source,
        verdict:          fingerprints.verdict,
        similarity_score: fingerprints.similarity_score,
        matched_model:    fingerprints.matched_model,
        fingerprint_hash: fingerprints.fingerprint_hash,
        created_at:       fingerprints.created_at,
        completed_at:     fingerprints.completed_at,
        step_events:      fingerprints.step_events,
      })
      .from(fingerprints)
      .where(whereClause)
      .orderBy(desc(fingerprints.created_at))
      .limit(limit)
      .offset(offset),

    // Count query using raw SQL for simplicity
    (async () => {
      const sql = getRawSql();
      if (conditions.length === 0) {
        const rows = await sql`SELECT COUNT(*)::int AS total FROM fingerprints`;
        return (rows as any[])[0]?.total ?? 0;
      } else if (status && verdict) {
        const rows = await sql`SELECT COUNT(*)::int AS total FROM fingerprints WHERE status = ${status} AND verdict = ${verdict}`;
        return (rows as any[])[0]?.total ?? 0;
      } else if (status) {
        const rows = await sql`SELECT COUNT(*)::int AS total FROM fingerprints WHERE status = ${status}`;
        return (rows as any[])[0]?.total ?? 0;
      } else {
        const rows = await sql`SELECT COUNT(*)::int AS total FROM fingerprints WHERE verdict = ${verdict}`;
        return (rows as any[])[0]?.total ?? 0;
      }
    })(),
  ]);

  const total = countResult as number;

  return {
    jobs,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
});
