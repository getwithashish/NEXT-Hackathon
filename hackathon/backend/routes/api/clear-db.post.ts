/**
 * POST /api/clear-db
 * Truncates all data tables. Keeps schema + known_models seeds intact.
 * One-shot utility — remove after use.
 */
import { defineEventHandler } from "h3";
import { getRawSql } from "../../lib/db/index";

export default defineEventHandler(async () => {
  try {
    const sql = getRawSql();

    // Truncate in dependency order (fingerprints references providers/models)
    await sql`TRUNCATE TABLE fingerprints RESTART IDENTITY CASCADE`;
    await sql`TRUNCATE TABLE models       RESTART IDENTITY CASCADE`;
    await sql`TRUNCATE TABLE accounts     RESTART IDENTITY CASCADE`;
    await sql`TRUNCATE TABLE providers    RESTART IDENTITY CASCADE`;
    // Keep known_models — those are reference data, not stale job data

    // Verify counts
    const fpRows = await sql`SELECT COUNT(*)::int AS n FROM fingerprints`;
    const prRows = await sql`SELECT COUNT(*)::int AS n FROM providers`;
    const kmRows = await sql`SELECT COUNT(*)::int AS n FROM known_models`;

    return {
      ok: true,
      message: "All job/provider data cleared. known_models preserved.",
      counts: {
        fingerprints: (fpRows as any[])[0]?.n ?? 0,
        providers:    (prRows as any[])[0]?.n ?? 0,
        known_models: (kmRows as any[])[0]?.n ?? 0,
      },
    };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});
