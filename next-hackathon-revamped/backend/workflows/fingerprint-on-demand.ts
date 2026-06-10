/**
 * workflows/fingerprint-on-demand.ts  (v1.3)
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
 * v1.3: each step writes step_started / step_completed / step_failed events into
 *       fingerprints.step_events via pushStepEvent() so the status endpoint can
 *       serve live progress from DB rather than the unreliable readable stream.
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
import { pushStepEvent } from "../lib/db/events";
import { eq } from "drizzle-orm";

// ── Step event helpers ────────────────────────────────────────────────────────

async function stepStarted(jobId: string, name: string) {
  await pushStepEvent(jobId, { type: "step_started", step_name: name, timestamp: new Date().toISOString() });
}
async function stepCompleted(jobId: string, name: string) {
  await pushStepEvent(jobId, { type: "step_completed", step_name: name, timestamp: new Date().toISOString() });
}
async function stepFailed(jobId: string, name: string, err: unknown) {
  await pushStepEvent(jobId, { type: "step_failed", step_name: name, timestamp: new Date().toISOString(), error: String(err) });
}

// ── Step 1: resolve template ──────────────────────────────────────────────────

async function stepResolveTemplate(
  jobId: string,
  apiEndpoint: string,
  apiKey: string,
  docUrl?: string,
  requestTemplate?: RequestTemplate
) {
  "use step";
  await stepStarted(jobId, "resolve-template");
  try {
    let result: RequestTemplate | null = null;
    if (requestTemplate) result = await validateTemplate(requestTemplate, apiKey);
    else if (docUrl)     result = await resolveTemplateFromDocs(docUrl, apiKey);
    await stepCompleted(jobId, "resolve-template");
    return result;
  } catch (err) {
    await stepFailed(jobId, "resolve-template", err);
    throw err;
  }
}

// ── Steps 2–4: fingerprint batches ───────────────────────────────────────────

async function stepFingerprintBatch0(
  jobId: string,
  apiEndpoint: string,
  apiKey: string,
  modelHint: string,
  template: RequestTemplate | null
) {
  "use step";
  await stepStarted(jobId, "fingerprint-batch-0");
  try {
    const result = await fingerprintBatch(0, apiEndpoint, apiKey, modelHint, template);
    await stepCompleted(jobId, "fingerprint-batch-0");
    return result;
  } catch (err) {
    await stepFailed(jobId, "fingerprint-batch-0", err);
    throw err;
  }
}

async function stepFingerprintBatch1(
  jobId: string,
  apiEndpoint: string,
  apiKey: string,
  modelHint: string,
  template: RequestTemplate | null
) {
  "use step";
  await stepStarted(jobId, "fingerprint-batch-1");
  try {
    const result = await fingerprintBatch(1, apiEndpoint, apiKey, modelHint, template);
    await stepCompleted(jobId, "fingerprint-batch-1");
    return result;
  } catch (err) {
    await stepFailed(jobId, "fingerprint-batch-1", err);
    throw err;
  }
}

async function stepFingerprintBatch2(
  jobId: string,
  apiEndpoint: string,
  apiKey: string,
  modelHint: string,
  template: RequestTemplate | null
) {
  "use step";
  await stepStarted(jobId, "fingerprint-batch-2");
  try {
    const result = await fingerprintBatch(2, apiEndpoint, apiKey, modelHint, template);
    await stepCompleted(jobId, "fingerprint-batch-2");
    return result;
  } catch (err) {
    await stepFailed(jobId, "fingerprint-batch-2", err);
    throw err;
  }
}

// ── Step 5: embed all 15 responses ────────────────────────────────────────────

async function stepEmbedResponses(
  jobId: string,
  batch0: Awaited<ReturnType<typeof fingerprintBatch>>,
  batch1: Awaited<ReturnType<typeof fingerprintBatch>>,
  batch2: Awaited<ReturnType<typeof fingerprintBatch>>
) {
  "use step";
  await stepStarted(jobId, "embed-responses");
  try {
    const result = await embedResponses([batch0, batch1, batch2]);
    await stepCompleted(jobId, "embed-responses");
    return result;
  } catch (err) {
    await stepFailed(jobId, "embed-responses", err);
    throw err;
  }
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
  await stepStarted(jobId, "compare-and-persist");
  try {
    const allResponses = [
      ...batch0.responses,
      ...batch1.responses,
      ...batch2.responses,
    ];

    const behaviorHash = computeBehaviorHash([batch0, batch1, batch2]);
    const { embedding_vectors, mean_vector } = embeddingResult;
    const { similar_models, verdict, similarity_score, matched_model } =
      await compareFingerprintEmbeddings(embedding_vectors, mean_vector, behaviorHash);

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

    await stepCompleted(jobId, "compare-and-persist");

    return {
      behavior_hash:    behaviorHash,
      similar_models,
      verdict,
      similarity_score,
      matched_model,
      embedding_vectors,
      mean_vector,
    };
  } catch (err) {
    await stepFailed(jobId, "compare-and-persist", err);
    throw err;
  }
}

// ── Step 7: pairwise cross-comparison ─────────────────────────────────────────

async function stepPairwiseSimilarities(
  jobId: string,
  embedding_vectors: number[][],
  mean_vector: number[]
) {
  "use step";
  await stepStarted(jobId, "pairwise-similarities");
  try {
    const pairwise = await compareAgainstAllFingerprints(jobId, embedding_vectors, mean_vector);
    await stepCompleted(jobId, "pairwise-similarities");
    return { pairwise_count: pairwise.length, pairwise };
  } catch (err) {
    await stepFailed(jobId, "pairwise-similarities", err);
    // Non-fatal — don't re-throw, workflow can still succeed
    return { pairwise_count: 0, pairwise: [] };
  }
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
    jobId, apiEndpoint, apiKey, docUrl, requestTemplate
  );

  const template: RequestTemplate | null =
    templateRaw && "endpoint_url" in templateRaw ? templateRaw : null;

  const batch0 = await stepFingerprintBatch0(jobId, apiEndpoint, apiKey, modelHint, template);
  const batch1 = await stepFingerprintBatch1(jobId, apiEndpoint, apiKey, modelHint, template);
  const batch2 = await stepFingerprintBatch2(jobId, apiEndpoint, apiKey, modelHint, template);

  const embeddingResult = await stepEmbedResponses(jobId, batch0, batch1, batch2);

  const result = await stepCompareAndPersist(
    jobId, modelName, batch0, batch1, batch2, embeddingResult
  );

  const pairwiseResult = await stepPairwiseSimilarities(
    jobId,
    result.embedding_vectors,
    result.mean_vector
  );

  return {
    job_id:           jobId,
    model_name:       modelName,
    behavior_hash:    result.behavior_hash,
    similar_models:   result.similar_models,
    verdict:          result.verdict,
    similarity_score: result.similarity_score,
    matched_model:    result.matched_model,
    pairwise_count:   pairwiseResult.pairwise_count,
  };
}
