/**
 * GET /api/fingerprint/:jobId/responses
 * Returns the probe responses stored in fingerprint_data for a given job.
 */
import { defineEventHandler, setHeader, getRouterParam } from "h3";
import { getRawSql } from "../../../../lib/db/index";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");

  const jobId = getRouterParam(event, "jobId");
  if (!jobId) {
    event.node.res.statusCode = 400;
    return { error: "jobId required" };
  }

  const sql = getRawSql();

  const rows = (await sql`
    SELECT job_id, model_name, fingerprint_data
    FROM fingerprints
    WHERE job_id = ${jobId}
    LIMIT 1
  `) as any[];

  if (!rows || rows.length === 0) {
    event.node.res.statusCode = 404;
    return { error: "not found" };
  }

  const row = rows[0];
  const fd = row.fingerprint_data ?? {};

  return {
    job_id:            row.job_id,
    model_name:        row.model_name,
    responses:         fd.responses         ?? [],
    batch_signatures:  fd.batch_signatures  ?? [],
  };
});
