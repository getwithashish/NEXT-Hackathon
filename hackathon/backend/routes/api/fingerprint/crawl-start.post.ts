/**
 * POST /api/fingerprint/crawl-start
 * Called by the payment-approval workflow (step 4) or directly by the EC2
 * crawler for free-tier providers. Starts a crawl-fingerprint workflow per model.
 */
import { defineEventHandler, readBody, setHeader } from "h3";
import { start } from "workflow/api";
import { crawlFingerprintWorkflow } from "../../../workflows/crawl-fingerprint";
import { db, fingerprints, models, providers } from "../../../lib/db/index";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  const body = await readBody(event) as any;
  const { provider_id, provider_name, api_key, docs_url, model_ids } = body ?? {};

  if (!provider_id || !api_key) {
    event.node.res.statusCode = 400;
    return { error: "provider_id and api_key are required" };
  }

  // Fetch provider to get base_url
  const [provider] = await db
    .select()
    .from(providers)
    .where(eq(providers.id, provider_id));

  if (!provider) {
    event.node.res.statusCode = 404;
    return { error: "Provider not found" };
  }

  const apiEndpoint = provider.base_url ?? "";
  const ids: string[] = model_ids ?? [];
  const runIds: string[] = [];

  for (const modelId of ids) {
    // Find or create model DB record
    let [modelRecord] = await db
      .select()
      .from(models)
      .where(eq(models.model_id, modelId));

    if (!modelRecord) {
      const [created] = await db
        .insert(models)
        .values({
          provider_id,
          model_id: modelId,
          model_name: modelId,
        })
        .returning();
      modelRecord = created;
    }

    const jobId = crypto.randomUUID();

    // Create fingerprint job record
    await db.insert(fingerprints).values({
      job_id: jobId,
      model_name: modelId,
      model_type: "api",
      status: "pending",
      source: "crawler",
      provider_id,
      step_events: [],
    });

    const run = await start(crawlFingerprintWorkflow, [
      jobId,
      provider_id,
      provider_name ?? provider.name,
      apiEndpoint,
      api_key,
      modelId,
      modelRecord.id,
      docs_url ?? provider.docs_url,
    ]);

    // Update record with run ID
    await db
      .update(fingerprints)
      .set({ workflow_run_id: run.runId, status: "running" })
      .where(eq(fingerprints.job_id, jobId));

    runIds.push(run.runId);
  }

  // Mark provider as fingerprinting
  await db
    .update(providers)
    .set({ status: "fingerprinting", updated_at: new Date() })
    .where(eq(providers.id, provider_id));

  return { run_ids: runIds, provider_id, model_count: ids.length };
});
