/**
 * GET /api/jobs
 * Returns recent fingerprint jobs (both on-demand and crawler).
 */
import { defineEventHandler, setHeader, getQuery } from "h3";
import { db, fingerprints } from "../../../lib/db/index";
import { desc } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  const query = getQuery(event);
  const limit = Math.min(Number(query.limit ?? 20), 100);

  const jobs = await db
    .select()
    .from(fingerprints)
    .orderBy(desc(fingerprints.created_at))
    .limit(limit);

  return { jobs };
});
