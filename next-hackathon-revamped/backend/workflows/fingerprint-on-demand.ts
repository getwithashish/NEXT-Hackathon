/**
 * workflows/fingerprint-on-demand.ts  (v1.2)
 *
 * 7-step pipeline:
 *   1. resolve-template      — validate endpoint / extract RequestTemplate via Exa+Claude
 *   2. fingerprint-batch-0   — send discriminative prompts 1–5, record responses + latency
 *   3. fingerprint-batch-1   — prompts 6–10
 *   4. fingerprint-batch-2   — prompts 11–15
 *   5. embed-responses       — call Bedrock Titan Embeddings v2 on all 15 responses
 *   6. compare-and-persist   — two-phase cosine vs known_models + DB write
 *   7. pairwise-similarities — compare against ALL fingerprints in DB → fingerprint_similarities
 *
 * Step 7 is what enables "Similar Models" — every new fingerprint is cross-compared
 * against every existing one (user-submitted AND crawler-generated).
 */

import {
  resolveTemplateFromDocs,
  validateTemplate,
  fingerprintBatch,
  computeBehaviorHash,
  embedResponses,
  compareFingerprintEmbeddings,
  compareAgainstAllFingerprints,
  type RequestTemplate,
} from "../lib/agents/index";
import { db, fingerprints } from "../lib/db/index";
import { eq } from "drizzle-orm";

// ── Step 1: resolve template ──────────────────────────────────────────────────

async function stepResolveTemplate(
  apiEndpoint: string,
  apiKey: string,
  docUrl?: string,
  requestTemplate?: RequestTemplate
) {
  "use step";
  if (requestTemplate) return await validateTemplate(requestTemplate, apiKey);
  if (docUrl)          return await resolveTemplateFromDocs(docUrl, apiKey);
  return null;
}

// ── Steps 2–4: fingerprint batches ───────────────────────────────────────────

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

// ── Step 5: embed all 15 responses ────────────────────────────────────────────

async function stepEmbedResponses(
  batch0: Awaited<ReturnType<typeof fingerprintBatch>>,
  batch1: Awaited<ReturnType<typeof fingerprintBatch>>,
  batch2: Awaited<ReturnType<typeof fingerprintBatch>>
) {
  "use step";
  return await embedResponses([batch0, batch1, batch2]);
}

// ── Step 6: compare vs known_models + persist ─────────────────────────────────

async function stepCompareAndPersist(
  jobId: string,
  modelName: string,
  batch0: Awaited<ReturnType<typeof fingerprintBatch>>,
  batch1: Awaited<ReturnType<typeof fingerprintBatch>>,
  batch2: Awaited<ReturnType<typeof fingerprintBatch>>,
  embeddingResult: Awaited<ReturnType<typeof embedResponses>>
) {
  "use step";

  const allResponses = [
    ...batch0.responses,
    ...batch1.responses,
    ...batch2.responses,
  ];

  // SHA-256 fast path (exact match)
  const behaviorHash = computeBehaviorHash([batch0, batch1, batch2]);

  // Two-phase embedding comparison vs known_models reference set
  const { embedding_vectors, mean_vector } = embeddingResult;
  const { similar_models, verdict, similarity_score, matched_model } =
    await compareFingerprintEmbeddings(embedding_vectors, mean_vector, behaviorHash);

  // Persist everything to DB — mark status=done so step 7 can find it
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

// ── Step 7: pairwise cross-comparison against all existing fingerprints ────────
// Runs AFTER step 6 has written status=done so this fingerprint is excluded
// from its own comparison. Writes both directions to fingerprint_similarities.

async function stepPairwiseSimilarities(
  jobId: string,
  embedding_vectors: number[][],
  mean_vector: number[]
) {
  "use step";
  const pairwise = await compareAgainstAllFingerprints(jobId, embedding_vectors, mean_vector);
  return { pairwise_count: pairwise.length, pairwise };
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

  const templateRaw = await stepResolveTemplate(
    apiEndpoint, apiKey, docUrl, requestTemplate
  );

  // Normalise: validateTemplate returns {ok,error}, not a RequestTemplate.
  const template: RequestTemplate | null =
    templateRaw && "endpoint_url" in templateRaw ? templateRaw : null;

  const batch0 = await stepFingerprintBatch0(apiEndpoint, apiKey, modelHint, template as RequestTemplate | null);
  const batch1 = await stepFingerprintBatch1(apiEndpoint, apiKey, modelHint, template as RequestTemplate | null);
  const batch2 = await stepFingerprintBatch2(apiEndpoint, apiKey, modelHint, template as RequestTemplate | null);

  const embeddingResult = await stepEmbedResponses(batch0, batch1, batch2);

  const result = await stepCompareAndPersist(
    jobId, modelName, batch0, batch1, batch2, embeddingResult
  );

  // Cross-compare against every other fingerprint in the DB
  const pairwiseResult = await stepPairwiseSimilarities(
    jobId,
    result.embedding_vectors,
    result.mean_vector
  );

  return {
    job_id:          jobId,
    model_name:      modelName,
    behavior_hash:   result.behavior_hash,
    similar_models:  result.similar_models,
    verdict:         result.verdict,
    similarity_score: result.similarity_score,
    matched_model:   result.matched_model,
    pairwise_count:  pairwiseResult.pairwise_count,
  };
}
