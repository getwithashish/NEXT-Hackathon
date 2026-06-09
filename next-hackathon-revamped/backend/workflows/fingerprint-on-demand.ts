/**
 * workflows/fingerprint-on-demand.ts
 *
 * Triggered by: POST /api/fingerprint/submit (user submits an endpoint + key)
 *
 * Steps:
 *   1. resolve-template   — validate/extract RequestTemplate
 *   2. fingerprint-batch-0 — prompts 1-5
 *   3. fingerprint-batch-1 — prompts 6-10
 *   4. fingerprint-batch-2 — prompts 11-15
 *   5. compare-and-persist — hash comparison + DB write
 *
 * Splitting into 3 batch steps keeps each step well under the 300s Vercel
 * function timeout (con #1 fix). The readable stream from getRun() emits a
 * step_completed event after each batch, giving the frontend real progress.
 */

import {
  resolveTemplateFromDocs,
  validateTemplate,
  fingerprintBatch,
  compareFingerprintHash,
  type RequestTemplate,
  type FingerprintResult,
} from "../lib/agents/index.js";
import { db, fingerprints } from "../lib/db/index.js";
import { eq } from "drizzle-orm";

// ── Step 1: resolve template ──────────────────────────────────────────────────

async function stepResolveTemplate(
  apiEndpoint: string,
  apiKey: string,
  docUrl?: string,
  requestTemplate?: RequestTemplate
) {
  "use step";
  if (requestTemplate) {
    return await validateTemplate(requestTemplate, apiKey);
  }
  if (docUrl) {
    return await resolveTemplateFromDocs(docUrl, apiKey);
  }
  // No template — pass null, ApiCallerAgent will auto-detect the provider
  return null;
}

// ── Steps 2-4: fingerprint in batches of 5 ───────────────────────────────────

async function stepFingerprintBatch0(
  apiEndpoint: string,
  apiKey: string,
  modelHint: string,
  template: RequestTemplate | null
) {
  "use step";
  return await fingerprintBatch(0, apiEndpoint, apiKey, modelHint, template);
}

async function stepFingerprintBatch1(
  apiEndpoint: string,
  apiKey: string,
  modelHint: string,
  template: RequestTemplate | null
) {
  "use step";
  return await fingerprintBatch(1, apiEndpoint, apiKey, modelHint, template);
}

async function stepFingerprintBatch2(
  apiEndpoint: string,
  apiKey: string,
  modelHint: string,
  template: RequestTemplate | null
) {
  "use step";
  return await fingerprintBatch(2, apiEndpoint, apiKey, modelHint, template);
}

// ── Step 5: compare + persist ─────────────────────────────────────────────────

async function stepCompareAndPersist(
  jobId: string,
  modelName: string,
  batch0: Awaited<ReturnType<typeof fingerprintBatch>>,
  batch1: Awaited<ReturnType<typeof fingerprintBatch>>,
  batch2: Awaited<ReturnType<typeof fingerprintBatch>>
) {
  "use step";
  // Merge partial signatures into a single behavior hash
  const allResponses = [...batch0.responses, ...batch1.responses, ...batch2.responses];
  const combinedHash = await import("node:crypto").then(({ createHash }) => {
    const sorted = [...allResponses].sort();
    return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
  });

  // Compare against known models
  const { similar_models, verdict } = await compareFingerprintHash(combinedHash);

  // Persist to DB
  await db
    .update(fingerprints)
    .set({
      fingerprint_hash: combinedHash,
      fingerprint_data: {
        responses: allResponses,
        similar_models,
        verdict,
        batch_signatures: [
          batch0.partial_signature,
          batch1.partial_signature,
          batch2.partial_signature,
        ],
      },
      status: "done",
      completed_at: new Date(),
    })
    .where(eq(fingerprints.job_id, jobId));

  return { behavior_hash: combinedHash, similar_models, verdict };
}

// ── Main workflow ─────────────────────────────────────────────────────────────

export async function fingerprintOnDemandWorkflow(
  jobId: string,
  apiEndpoint: string,
  apiKey: string,
  modelName: string,
  modelHint: string,
  docUrl?: string,
  requestTemplate?: RequestTemplate
) {
  "use workflow";

  const template = await stepResolveTemplate(
    apiEndpoint, apiKey, docUrl, requestTemplate
  );

  const batch0 = await stepFingerprintBatch0(apiEndpoint, apiKey, modelHint, template);
  const batch1 = await stepFingerprintBatch1(apiEndpoint, apiKey, modelHint, template);
  const batch2 = await stepFingerprintBatch2(apiEndpoint, apiKey, modelHint, template);

  const result = await stepCompareAndPersist(jobId, modelName, batch0, batch1, batch2);

  return {
    job_id: jobId,
    model_name: modelName,
    ...result,
  };
}
