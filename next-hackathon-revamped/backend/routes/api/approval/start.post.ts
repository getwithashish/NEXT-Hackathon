/**
 * POST /api/approval/start
 * Called by the EC2 crawler when a provider requires an API key.
 * Starts a payment-approval workflow for that provider.
 *
 * Body: { provider_id, provider_name, docs_url?, pricing_url?, model_ids? }
 */
import { defineEventHandler, readBody, setHeader } from "h3";
import { start } from "workflow/api";
import { paymentApprovalWorkflow } from "../../../workflows/payment-approval.js";
import { db, providers } from "../../../lib/db/index.js";
import { eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  const body = await readBody(event) as any;
  const { provider_id, provider_name, docs_url, pricing_url, model_ids } = body ?? {};

  if (!provider_id) {
    event.node.res.statusCode = 400;
    return { error: "provider_id required" };
  }

  const run = await start(paymentApprovalWorkflow, [
    provider_id,
    provider_name ?? "Unknown Provider",
    docs_url ?? null,
    pricing_url ?? null,
    model_ids ?? [],
  ]);

  // Store run_id so we can look it up later
  await db
    .update(providers)
    .set({ approval_run_id: run.runId, updated_at: new Date() })
    .where(eq(providers.id, provider_id));

  return { run_id: run.runId, provider_id };
});
