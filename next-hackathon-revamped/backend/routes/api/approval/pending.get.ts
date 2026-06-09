/**
 * GET /api/approval/pending
 * Returns all providers in "needs_api_key" status for the frontend approval UI.
 */
import { defineEventHandler, setHeader } from "h3";
import { db, providers, accounts } from "../../../lib/db/index.js";
import { eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");

  const pending = await db
    .select()
    .from(providers)
    .where(eq(providers.status, "needs_api_key"));

  return { pending };
});
