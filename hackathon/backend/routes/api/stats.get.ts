/**
 * GET /api/stats
 * Returns aggregate stats for all fingerprint jobs.
 */
import { defineEventHandler, setHeader } from "h3";
import { getRawSql } from "../../lib/db/index";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  setHeader(event, "Cache-Control", "no-store");

  const sql = getRawSql();

  const rows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE TRUE) AS total_jobs,
      COUNT(*) FILTER (WHERE status = 'done') AS done_jobs,
      COUNT(*) FILTER (WHERE status = 'running') AS running_jobs,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed_jobs,
      COUNT(*) FILTER (WHERE status = 'pending') AS pending_jobs,
      COUNT(*) FILTER (WHERE verdict = 'exact_match') AS exact_match,
      COUNT(*) FILTER (WHERE verdict = 'clone_suspect') AS clone_suspect,
      COUNT(*) FILTER (WHERE verdict = 'high_similarity') AS high_similarity,
      COUNT(*) FILTER (WHERE verdict = 'same_family') AS same_family,
      COUNT(*) FILTER (WHERE verdict = 'distinct') AS distinct_verdict,
      COUNT(DISTINCT split_part(model_name, '/', 1)) AS unique_providers,
      ROUND(AVG(similarity_score)::numeric, 4) AS avg_similarity
    FROM fingerprints
  `) as any[];

  return rows[0];
});
