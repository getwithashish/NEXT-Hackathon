/**
 * GET /api/debug-schema
 * Returns actual column names from fingerprints table in Neon.
 */
import { defineEventHandler } from "h3";
import { getRawSql } from "../../lib/db/index";

export default defineEventHandler(async () => {
  try {
    const sql = getRawSql();
    const rows = await sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'fingerprints'
      ORDER BY ordinal_position
    `;
    return { ok: true, columns: rows };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});
