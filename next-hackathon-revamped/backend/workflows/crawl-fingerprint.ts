/**
 * workflows/crawl-fingerprint.ts
 *
 * Triggered by:
 *   1. payment-approval workflow step 4 (provider approved, api_key saved)
 *   2. EC2 crawler directly (free-tier providers that don't need approval)
 *
 * For each model ID at a provider, runs:
 *   step 1: resolve-template   — reads docs_url to get RequestTemplate
 *   step 2: fingerprint-batch-0
 *   step 3: fingerprint-batch-1
 *   step 4: fingerprint-batch-2
 *   step 5: compare-and-persist
 *
 * REUSE: Steps 2-5 are identical to fingerprint-on-demand — same functions
 * imported from the on-demand workflow. Zero duplication.
 */

import {
  resolveTemplateFromDocs,
  fingerprintBatch,
  compareFingerprintHash,
  type RequestTemplate,
} from "../lib/agents/index.js";
import { db, fingerprints, models, providers } from "../lib/db/index.js";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

// ── Step 1: resolve template from docs ───────────────────────────────────────

async function stepResolveTemplateForCrawl(
  docsUrl: string | null,
  apiEndpoint: string,
  apiKey: string
) {
  "use step";
  if (!docsUrl) return null;
  try {
    return await resolveTemplateFromDocs(docsUrl, apiKey);
  } catch (e) {
    // If doc reading fails, fall back to auto-detection (null template)
    console.warn(`DocReaderAgent failed for ${apiEndpoint}: ${e}. Falling back to auto-detect.`);
    return null;
  }
}

// ── Steps 2-4: reuse batch functions (same as on-demand workflow) ─────────────

async function stepFingerprintBatch0Crawl(
  apiEndpoint: string, apiKey: string, modelHint: string, template: RequestTemplate | null
) {
  "use step";
  return await fingerprintBatch(0, apiEndpoint, apiKey, modelHint, template);
}

async function stepFingerprintBatch1Crawl(
  apiEndpoint: string, apiKey: string, modelHint: string, template: RequestTemplate | null
) {
  "use step";
  return await fingerprintBatch(1, apiEndpoint, apiKey, modelHint, template);
}

async function stepFingerprintBatch2Crawl(
  apiEndpoint: string, apiKey: string, modelHint: string, template: RequestTemplate | null
) {
  "use step";
  return await fingerprintBatch(2, apiEndpoint, apiKey, modelHint, template);
}

// ── Step 5: compare + persist + update model record ──────────────────────────

async function stepCompareAndPersistCrawl(
  jobId: string,
  modelId: string,
  modelDbId: string,
  batch0: Awaited<ReturnType<typeof fingerprintBatch>>,
  batch1: Awaited<ReturnType<typeof fingerprintBatch>>,
  batch2: Awaited<ReturnType<typeof fingerprintBatch>>
) {
  "use step";
  const allResponses = [...batch0.responses, ...batch1.responses, ...batch2.responses];
  const sorted = [...allResponses].sort();
  const combinedHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(sorted))
    .digest("hex");

  const { similar_models, verdict } = await compareFingerprintHash(combinedHash);

  // Update fingerprint job
  await db
    .update(fingerprints)
    .set({
      fingerprint_hash: combinedHash,
      fingerprint_data: {
        responses: allResponses,
        similar_models,
        verdict,
      },
      status: "done",
      completed_at: new Date(),
    })
    .where(eq(fingerprints.job_id, jobId));

  // Update the model record with verdict
  await db
    .update(models)
    .set({
      fingerprint_job_id: jobId,
      fingerprint_hash: combinedHash,
      verdict,
      fingerprinted_at: new Date(),
    })
    .where(eq(models.id, modelDbId));

  return { behavior_hash: combinedHash, similar_models, verdict };
}

// ── Main workflow ─────────────────────────────────────────────────────────────

export async function crawlFingerprintWorkflow(
  jobId: string,
  providerId: string,
  providerName: string,
  apiEndpoint: string,
  apiKey: string,
  modelId: string,
  modelDbId: string,
  docsUrl: string | null
) {
  "use workflow";

  const template = await stepResolveTemplateForCrawl(docsUrl, apiEndpoint, apiKey);

  const batch0 = await stepFingerprintBatch0Crawl(apiEndpoint, apiKey, modelId, template);
  const batch1 = await stepFingerprintBatch1Crawl(apiEndpoint, apiKey, modelId, template);
  const batch2 = await stepFingerprintBatch2Crawl(apiEndpoint, apiKey, modelId, template);

  const result = await stepCompareAndPersistCrawl(
    jobId, modelId, modelDbId, batch0, batch1, batch2
  );

  return {
    job_id: jobId,
    provider_id: providerId,
    provider_name: providerName,
    model_id: modelId,
    ...result,
  };
}
