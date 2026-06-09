/**
 * lib/agents/index.ts
 *
 * TypeScript wrappers that call the existing Python agents running on the
 * EC2 backend (54.86.179.209:8000).
 *
 * Design principle:
 *   - Python agents (ApiCallerAgent, DocReaderAgent, CustomTemplateCallerAgent)
 *     are NOT rewritten. They are invoked via new thin HTTP endpoints added to
 *     the existing FastAPI backend.
 *   - These wrappers are the ONLY place in the codebase that knows the EC2 URL.
 *   - Both fingerprint-on-demand and crawl-fingerprint workflows import from here
 *     — zero duplication.
 */

const EC2_URL = process.env.EC2_BACKEND_URL ?? "http://54.86.179.209:8000";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RequestTemplate {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body_template?: Record<string, unknown>;
  auth_type?: string;
  query_params?: Record<string, string>;
  content_type?: string;
  auth_param_name?: string;
  response_path?: string;
}

export interface FingerprintResult {
  behavior_hash: string;
  behavioral_signature: {
    behavior_hash: string;
    avg_response_length: number;
    std_response_length: number;
    avg_latency_ms: number;
    top_vocab: string[];
    sample_count: number;
  };
  responses_s3_key?: string;
  model_name: string;
  duration_seconds: number;
}

export interface SimilarModel {
  name: string;
  source: string;
  similarity: number;
  from: string;
}

// ── DocReaderAgent ─────────────────────────────────────────────────────────────
// Fetches a provider doc URL, uses Claude to extract a RequestTemplate.

export async function resolveTemplateFromDocs(
  docUrl: string,
  apiKey: string
): Promise<RequestTemplate> {
  const res = await fetch(`${EC2_URL}/agents/doc-reader`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ doc_url: docUrl, api_key: apiKey }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DocReaderAgent failed (${res.status}): ${err}`);
  }
  return res.json() as Promise<RequestTemplate>;
}

// ── CustomTemplateCallerAgent ─────────────────────────────────────────────────
// Validates a user-supplied Postman-style template with a live test call.

export async function validateTemplate(
  template: RequestTemplate,
  apiKey: string
): Promise<RequestTemplate> {
  const res = await fetch(`${EC2_URL}/agents/validate-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template, api_key: apiKey }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`CustomTemplateCallerAgent failed (${res.status}): ${err}`);
  }
  return res.json() as Promise<RequestTemplate>;
}

// ── ApiCallerAgent — fingerprint ──────────────────────────────────────────────
// Sends the 15-prompt battery in 3 batches of 5 (avoids the 300s step timeout).
// Returns partial results after each batch so step events can be streamed.

export async function fingerprintBatch(
  batchIndex: 0 | 1 | 2,
  apiEndpoint: string,
  apiKey: string,
  modelHint: string,
  template: RequestTemplate | null
): Promise<{ responses: string[]; partial_signature: Partial<FingerprintResult["behavioral_signature"]> }> {
  const res = await fetch(`${EC2_URL}/agents/fingerprint-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      batch_index: batchIndex,
      api_endpoint: apiEndpoint,
      api_key: apiKey,
      model_hint: modelHint,
      request_template: template,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`fingerprintBatch(${batchIndex}) failed (${res.status}): ${err}`);
  }
  return res.json();
}

// ── Fingerprint — combine all batches ────────────────────────────────────────

export async function fingerprintFull(
  apiEndpoint: string,
  apiKey: string,
  modelHint: string,
  template: RequestTemplate | null
): Promise<FingerprintResult> {
  const res = await fetch(`${EC2_URL}/agents/fingerprint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_endpoint: apiEndpoint,
      api_key: apiKey,
      model_hint: modelHint,
      request_template: template,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`fingerprintFull failed (${res.status}): ${err}`);
  }
  return res.json() as Promise<FingerprintResult>;
}

// ── Similarity comparison ─────────────────────────────────────────────────────

export async function compareFingerprintHash(
  behaviorHash: string
): Promise<{ similar_models: SimilarModel[]; verdict: string }> {
  const res = await fetch(`${EC2_URL}/fingerprint/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ behavior_hash: behaviorHash }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`compareFingerprintHash failed (${res.status}): ${err}`);
  }
  return res.json();
}
