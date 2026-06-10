/**
 * workflows/crawl-fingerprint.ts  (v1.2)
 *
 * Triggered by:
 *   1. payment-approval workflow step 4 (provider approved, api_key saved)
 *   2. EC2 crawler directly (free-tier providers that don't need approval)
 *
 * 7-step pipeline (mirrors fingerprint-on-demand.ts v1.2):
 *   1. resolve-template         — reads docs_url → RequestTemplate
 *   2. fingerprint-batch-0      — prompts 1–5
 *   3. fingerprint-batch-1      — prompts 6–10
 *   4. fingerprint-batch-2      — prompts 11–15
 *   5. embed-responses          — Bedrock Titan v2 embeddings
 *   6. compare-and-persist      — cosine vs known_models + DB write
 *   7. pairwise-similarities    — cross-compare vs ALL fingerprints in DB
 *
 * Source field on the fingerprint row is "crawler" so the frontend can
 * distinguish crawler-generated entries from user-submitted ones.
 */

import {
  resolveTemplateFromDocs,
  fingerprintBatch,
  computeBehaviorHash,
  embedResponses,
  compareFingerprintEmbeddings,
  compareAgainstAllFingerprints,
  type RequestTemplate,
} from "../lib/agents/index";
import { db, fingerprints, models } from "../lib/db/index";
import { eq } from "drizzle-orm";

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
    console.warn(`DocReaderAgent failed for ${apiEndpoint}: ${e}. Falling back to auto-detect.`);
    return null;
  }
}

// ── Steps 2-4: fingerprint batches ───────────────────────────────────────────

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

// ── Step 5: embed all 15 responses ───────────────────────────────────────────

async function stepEmbedResponsesCrawl(
  batch0: Awaited<ReturnType<typeof fingerprintBatch>>,
  batch1: Awaited<ReturnType<typeof fingerprintBatch>>,
  batch2: Awaited<ReturnType<typeof fingerprintBatch>>
) {
  "use step";
  return await embedResponses([batch0, batch1, batch2]);
}

// ── Step 6: compare vs known_models + persist ────────────────────────────────

async function stepCompareAndPersistCrawl(
  jobId: string,
  modelId: string,
  modelDbId: string,
  batch0: Awaited<ReturnType<typeof fingerprintBatch>>,
  batch1: Awaited<ReturnType<typeof fingerprintBatch>>,
  batch2: Awaited<ReturnType<typeof fingerprintBatch>>,
  embeddingResult: Awaited<ReturnType<typeof embedResponses>>
) {
  "use step";

  const allResponses = [...batch0.responses, ...batch1.responses, ...batch2.responses];
  const behaviorHash = computeBehaviorHash([batch0, batch1, batch2]);

  const { embedding_vectors, mean_vector } = embeddingResult;
  const { similar_models, verdict, similarity_score, matched_model } =
    await compareFingerprintEmbeddings(embedding_vectors, mean_vector, behaviorHash);

  // Persist fingerprint — source="crawler" distinguishes from user-submitted
  await db
    .update(fingerprints)
    .set({
      fingerprint_hash:  behaviorHash,
      embedding_vectors: embedding_vectors as any,
      mean_vector:       mean_vector       as any,
      similarity_score,
      matched_model:     matched_model ?? undefined,
      verdict,
      fingerprint_data: {
        responses: allResponses,
        similar_models,
        verdict,
        similarity_score,
        matched_model,
        batch_signatures: [
          batch0.partial_signature,
          batch1.partial_signature,
          batch2.partial_signature,
        ],
      },
      status:       "done",
      completed_at: new Date(),
    })
    .where(eq(fingerprints.job_id, jobId));

  // Update the model record
  await db
    .update(models)
    .set({
      fingerprint_job_id: jobId,
      fingerprint_hash:   behaviorHash,
      verdict,
      fingerprinted_at:   new Date(),
    })
    .where(eq(models.id, modelDbId));

  return {
    behavior_hash:    behaviorHash,
    similar_models,
    verdict,
    similarity_score,
    matched_model,
    embedding_vectors,
    mean_vector,
  };
}

// ── Step 7: pairwise cross-comparison against all existing fingerprints ───────

async function stepPairwiseSimilaritiesCrawl(
  jobId: string,
  embedding_vectors: number[][],
  mean_vector: number[]
) {
  "use step";
  const pairwise = await compareAgainstAllFingerprints(jobId, embedding_vectors, mean_vector);
  return { pairwise_count: pairwise.length, pairwise };
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

  const embeddingResult = await stepEmbedResponsesCrawl(batch0, batch1, batch2);

  const result = await stepCompareAndPersistCrawl(
    jobId, modelId, modelDbId, batch0, batch1, batch2, embeddingResult
  );

  const pairwiseResult = await stepPairwiseSimilaritiesCrawl(
    jobId,
    result.embedding_vectors,
    result.mean_vector
  );

  return {
    job_id:          jobId,
    provider_id:     providerId,
    provider_name:   providerName,
    model_id:        modelId,
    behavior_hash:   result.behavior_hash,
    verdict:         result.verdict,
    similarity_score: result.similarity_score,
    matched_model:   result.matched_model,
    pairwise_count:  pairwiseResult.pairwise_count,
  };
}
