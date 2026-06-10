/**
 * GET /api/fingerprint/:jobId/similar
 *
 * Returns all fingerprints similar to the given job_id, ranked by score desc.
 * Reads from fingerprint_similarities (written by compareAgainstAllFingerprints
 * in workflow step 7). Both directions are stored (fp_a→fp_b AND fp_b→fp_a),
 * so a simple WHERE fp_a = :jobId is sufficient.
 *
 * Response shape:
 *   {
 *     job_id: string,
 *     similar: Array<{
 *       job_id:           string,
 *       model_name:       string | null,
 *       provider_name:    string | null,
 *       similarity_score: number,        // cosine [0,1]
 *       verdict:          string | null,
 *       source:           string | null,
 *       completed_at:     string | null,
 *     }>
 *   }
 */

import { defineEventHandler, getRouterParam, setHeader } from "h3";
import { getRawSql } from "../../../../lib/db/index";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  setHeader(event, "Cache-Control", "no-store");

  const jobId = getRouterParam(event, "jobId");
  if (!jobId) {
    event.node.res.statusCode = 400;
    return { error: "jobId is required" };
  }

  try {
    const sql = getRawSql();

    const rows = (await sql`
      SELECT
        s.fp_b                  AS job_id,
        f.model_name,
        p.name                  AS provider_name,
        s.score                 AS similarity_score,
        s.verdict,
        f.source,
        f.completed_at
      FROM fingerprint_similarities s
      LEFT JOIN fingerprints f ON f.job_id = s.fp_b
      LEFT JOIN providers    p ON p.id      = f.provider_id
      WHERE s.fp_a = ${jobId}
      ORDER BY s.score DESC
      LIMIT 50
    `) as any[];

    return {
      job_id:  jobId,
      similar: rows.map((r: any) => ({
        job_id:           r.job_id,
        model_name:       r.model_name  ?? null,
        provider_name:    r.provider_name ?? null,
        similarity_score: parseFloat(r.similarity_score ?? "0"),
        verdict:          r.verdict     ?? null,
        source:           r.source      ?? null,
        completed_at:     r.completed_at ? String(r.completed_at) : null,
      })),
    };
  } catch (err: any) {
    console.error("[similar.get]", err);
    event.node.res.statusCode = 500;
    return { error: String(err?.message ?? err) };
  }
});
