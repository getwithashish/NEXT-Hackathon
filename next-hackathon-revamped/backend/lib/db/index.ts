/**
 * db/index.ts — Neon Postgres connection via the serverless HTTP driver.
 *
 * Uses @neondatabase/serverless instead of node-postgres (pg) so that
 * Vercel serverless functions don't hold TCP connections open — fixes the
 * connection pool exhaustion problem.
 *
 * DATABASE_URL must be set in Vercel env vars (and .env for local dev).
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });

export * from "./schema.js";
