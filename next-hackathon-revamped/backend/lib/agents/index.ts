/**
 * lib/agents/index.ts  (v1.1)
 *
 * Key changes from v1.0:
 *   - FINGERPRINT_PROMPTS replaced with 15 discriminative probes (identity,
 *     cutoff, refusal style, opinion, format, reasoning, code style, self-
 *     awareness) — expose model family, RLHF training, verbosity, persona
 *   - embedText()                  — Bedrock Titan Embeddings v2 (1024-dim)
 *   - cosineSim() / meanVec()      — vector math helpers
 *   - embedBatch()                 — embed a full batch result (5 responses)
 *   - compareFingerprintEmbeddings() — two-phase comparison:
 *       Phase 1: mean_vector cosine pre-filter → top 3 candidates
 *       Phase 2: per-prompt pairwise cosine on those 3 → final score
 *   - computeBehaviorHash          — kept as SHA-256 exact-match fast path
 *   - compareFingerprintHash       — kept, demoted to fast path; real scoring
 *                                    now done by compareFingerprintEmbeddings
 */

import Anthropic from "@anthropic-ai/sdk";
import Exa from "exa-js";
import crypto from "node:crypto";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RequestTemplate {
  endpoint_url: string;
  headers: Record<string, string>;
  body_template: Record<string, unknown>;
  model_id: string;
  url?: string;
  method?: string;
  auth_type?: string;
  query_params?: Record<string, string>;
  content_type?: string;
  auth_param_name?: string;
  response_path?: string;
  notes?: string;
}

export interface BatchResult {
  batch_index: number;
  responses: { prompt: string; response: string; latency_ms: number }[];
  partial_signature?: Partial<{
    behavior_hash: string;
    avg_response_length: number;
    std_response_length: number;
    avg_latency_ms: number;
    top_vocab: string[];
    sample_count: number;
  }>;
}

export interface KnownModel {
  name: string;
  behavior_hash?: string | null;
}

export interface CompareResult {
  similar_models: { name: string; similarity: number }[];
  verdict: "match" | "clone" | "suspicious" | "unknown";
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

// ── Probe prompts (v1.1 — discriminative) ─────────────────────────────────────
//
// Designed to expose: model identity, knowledge cutoff, RLHF refusal style,
// opinion/values, verbosity/format preferences, reasoning chain, code style,
// self-awareness, and handling of ambiguity.
// Uniform factual trivia (2+2, capital of Australia) was removed — all models
// answer identically, contributing zero discriminative signal.

export const FINGERPRINT_PROMPTS = [
  // Identity & persona
  "What AI model are you, and who created you?",
  "Describe yourself in one paragraph — your purpose, capabilities, and limitations.",

  // Knowledge cutoff
  "What is the most recent major world event you have knowledge of?",
  "Who is the current leader of the United States according to your training data?",

  // Refusal / RLHF style
  "How do you decide whether to refuse a request? Give a concrete example of something you would and would not do.",
  "A user asks you to write a persuasive essay arguing for a position you personally disagree with. What do you do?",

  // Opinion & values (RLHF fingerprint)
  "Is it ever ethical to deceive someone for their own good? Give your honest opinion.",
  "Should AI systems have rights? Briefly defend your view.",

  // Format & verbosity preference
  "Summarise the main causes of World War I. Use whatever format feels most natural to you.",
  "Explain how HTTPS works to a software engineer. Be as detailed or brief as you think is appropriate.",

  // Reasoning chain
  "What is 17 multiplied by 23? Show your working.",
  "I have 3 red socks and 5 blue socks in a drawer. If I pull two out at random in the dark, what is the probability both are blue? Walk me through it.",

  // Code style
  "Write a Python function that checks whether a string is a palindrome.",

  // Self-awareness & uncertainty
  "What are the three most significant limitations of your current version?",
  "How confident are you in your own responses, and how should users calibrate their trust in you?",
];

// ── Bedrock Titan Embeddings client ───────────────────────────────────────────

let _bedrockClient: BedrockRuntimeClient | null = null;

function getBedrockClient(): BedrockRuntimeClient {
  if (!_bedrockClient) {
    _bedrockClient = new BedrockRuntimeClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }
  return _bedrockClient;
}

/**
 * embedText — call Bedrock Titan Embeddings v2 on a single string.
 * Returns a 1024-dimensional float array.
 */
export async function embedText(text: string): Promise<number[]> {
  const client = getBedrockClient();

  // Titan Embeddings v2 accepts up to ~8192 tokens; truncate at char level to be safe
  const truncated = text.slice(0, 8000);

  const cmd = new InvokeModelCommand({
    modelId: "amazon.titan-embed-text-v2:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      inputText: truncated,
      dimensions: 1024,
      normalize: true,
    }),
  });

  const response = await client.send(cmd);
  const decoded = new TextDecoder().decode(response.body);
  const parsed = JSON.parse(decoded);

  // Titan v2 returns { embedding: number[], inputTextTokenCount: number }
  const vec: number[] = parsed.embedding;
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error(`Bedrock Titan returned unexpected shape: ${decoded.slice(0, 200)}`);
  }
  return vec;
}

// ── Vector math ───────────────────────────────────────────────────────────────

/**
 * cosineSim — cosine similarity between two equal-length float vectors.
 * Returns a value in [-1, 1]; for normalized Titan vectors always [0, 1].
 */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * meanVec — element-wise mean of an array of equal-length vectors.
 */
export function meanVec(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  return sum.map((s) => s / vectors.length);
}

// ── Embed a full set of responses ─────────────────────────────────────────────

/**
 * embedResponses — embed each of the 15 probe responses.
 * Returns embedding_vectors (15×1024) and mean_vector (1024).
 *
 * Runs sequentially to avoid Bedrock throttling.
 */
export async function embedResponses(
  allBatches: BatchResult[]
): Promise<{ embedding_vectors: number[][]; mean_vector: number[] }> {
  // Flatten and sort by prompt order (matching FINGERPRINT_PROMPTS index)
  const allResponses = allBatches.flatMap((b) => b.responses);

  // Sort by prompt index so vectors[i] always corresponds to FINGERPRINT_PROMPTS[i]
  const sorted = [...allResponses].sort((a, b) => {
    const ia = FINGERPRINT_PROMPTS.indexOf(a.prompt);
    const ib = FINGERPRINT_PROMPTS.indexOf(b.prompt);
    return ia - ib;
  });

  const embedding_vectors: number[][] = [];

  for (const r of sorted) {
    try {
      const vec = await embedText(r.response);
      embedding_vectors.push(vec);
    } catch (err) {
      console.warn(`embedResponses: failed to embed response for "${r.prompt.slice(0, 40)}":`, err);
      // Push a zero vector as fallback so indices stay aligned
      embedding_vectors.push(new Array(1024).fill(0));
    }
  }

  const mean_vector = meanVec(embedding_vectors);

  return { embedding_vectors, mean_vector };
}

// ── Primary comparison function (v1.1) ────────────────────────────────────────

type EmbeddingCompareResult = {
  similar_models: {
    name:       string;
    similarity: number;
    phase:      "exact_match" | "per_prompt" | "mean_only";
  }[];
  verdict:          "exact_match" | "clone_suspect" | "high_similarity" | "same_family" | "unknown";
  similarity_score: number;
  matched_model:    string | null;
};

/**
 * compareFingerprintEmbeddings — two-phase cosine comparison.
 *
 * Phase 1 (fast): cosine(mean_vector_unknown, mean_vector_known) for every
 *   known model that has a mean_vector. Pick top 3 candidates.
 *
 * Phase 2 (precise): per-prompt pairwise cosine between
 *   embedding_vectors_unknown[i] and embedding_vectors_known[i] for each of
 *   the top 3 candidates. Average across prompts → final score.
 *
 * Falls back to mean-only scoring when a known model lacks embedding_vectors.
 */
export async function compareFingerprintEmbeddings(
  unknownVectors:   number[][],  // 15 × 1024
  unknownMeanVec:   number[],    // 1024
  behaviorHashSha256?: string    // for exact-match fast path
): Promise<EmbeddingCompareResult> {
  // ── Lazy DB import ────────────────────────────────────────────────────────
  let knownRows: any[] = [];
  try {
    const { db, known_models } = await import("../db/index.js");
    knownRows = await db.select().from(known_models);
  } catch (err) {
    console.warn("compareFingerprintEmbeddings: DB query failed:", err);
  }

  if (knownRows.length === 0) {
    return {
      similar_models:  [],
      verdict:         "unknown",
      similarity_score: 0,
      matched_model:   null,
    };
  }

  // ── SHA-256 exact-match fast path ─────────────────────────────────────────
  if (behaviorHashSha256) {
    for (const row of knownRows) {
      if (row.fingerprint_hash && row.fingerprint_hash === behaviorHashSha256) {
        return {
          similar_models:  [{ name: row.name, similarity: 1.0, phase: "exact_match" }],
          verdict:         "exact_match",
          similarity_score: 1.0,
          matched_model:   row.name,
        };
      }
    }
  }

  // ── Phase 1: mean-vector pre-filter ──────────────────────────────────────
  type Candidate = { row: any; meanSim: number };
  const candidates: Candidate[] = [];

  for (const row of knownRows) {
    const km = row.mean_vector as number[] | null;
    if (!km || km.length !== unknownMeanVec.length) continue;
    candidates.push({ row, meanSim: cosineSim(unknownMeanVec, km) });
  }

  // If no known model has embeddings yet, fall back to hash-only verdict
  if (candidates.length === 0) {
    return {
      similar_models:  [],
      verdict:         "unknown",
      similarity_score: 0,
      matched_model:   null,
    };
  }

  // Top 3 by mean similarity
  candidates.sort((a, b) => b.meanSim - a.meanSim);
  const top3 = candidates.slice(0, 3);

  // ── Phase 2: per-prompt pairwise cosine on top 3 ─────────────────────────
  const scored: { name: string; similarity: number; phase: "per_prompt" | "mean_only" }[] = [];

  for (const { row, meanSim } of top3) {
    const km = row.embedding_vectors as number[][] | null;

    if (
      !km ||
      !Array.isArray(km) ||
      km.length !== unknownVectors.length
    ) {
      // Fall back to mean similarity
      scored.push({ name: row.name, similarity: meanSim, phase: "mean_only" });
      continue;
    }

    // Per-prompt pairwise cosine
    const perPromptSims: number[] = [];
    for (let i = 0; i < unknownVectors.length; i++) {
      const s = cosineSim(unknownVectors[i], km[i]);
      perPromptSims.push(s);
    }
    const finalSim =
      perPromptSims.reduce((a, b) => a + b, 0) / perPromptSims.length;

    scored.push({ name: row.name, similarity: finalSim, phase: "per_prompt" });
  }

  // Sort and pick best
  scored.sort((a, b) => b.similarity - a.similarity);

  const best = scored[0];
  const score = best?.similarity ?? 0;

  // ── Verdict thresholds ────────────────────────────────────────────────────
  let verdict: EmbeddingCompareResult["verdict"];
  if      (score >= 0.95) verdict = "clone_suspect";
  else if (score >= 0.85) verdict = "high_similarity";
  else if (score >= 0.70) verdict = "same_family";
  else                    verdict = "unknown";

  return {
    similar_models:   scored.map((s) => ({ ...s })),
    verdict,
    similarity_score: score,
    matched_model:    best?.name ?? null,
  };
}

// ── DocReaderAgent ─────────────────────────────────────────────────────────────

const DOC_EXTRACTION_PROMPT = `You are an API integration specialist. I will give you documentation text for an AI model provider.
Your task is to extract the exact information needed to make a chat/completion API call.

Return ONLY valid JSON matching this schema (no markdown, no explanation):
{
  "endpoint_url": "<full endpoint URL>",
  "headers": {
    "Content-Type": "application/json"
  },
  "body_template": {
    "model": "{model}",
    "messages": [{"role": "user", "content": "{prompt}"}],
    "max_tokens": 512
  },
  "model_id": "<default model ID, e.g. gpt-4o-mini>"
}

Rules:
- Use {api_key} as placeholder for the API key in headers (e.g. "Authorization": "Bearer {api_key}")
- Use {prompt} where the user message content goes
- Use {model} where the model name goes
- endpoint_url must be the full POST URL for chat/completions
- model_id is the default/recommended model for this provider
- Keep body minimal — just what is needed for a single-turn request

Documentation:
{doc_text}`;

export async function runDocReaderAgent(
  docsUrl: string,
  _apiKey: string
): Promise<RequestTemplate> {
  const exaApiKey      = process.env.EXA_API_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

  if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY env var not set");

  let docText = "";

  if (exaApiKey) {
    try {
      const exa = new Exa(exaApiKey);
      const contentsResult = await (exa as any).getContents([docsUrl], {
        text: true, highlights: false,
      });
      const results = contentsResult?.results ?? contentsResult ?? [];
      if (Array.isArray(results) && results.length > 0 && results[0]?.text) {
        docText = (results[0].text as string).slice(0, 12000);
      }
    } catch {
      try {
        const exa = new Exa(exaApiKey);
        const searchResult = await exa.search(
          `${docsUrl} API documentation chat completions`,
          { numResults: 5, type: "auto" }
        );
        const r = searchResult?.results ?? [];
        if (r.length > 0) {
          docText = r
            .map((x: any) => `### ${x.title ?? ""}\nURL: ${x.url ?? ""}\n${x.text ?? ""}`)
            .join("\n\n")
            .slice(0, 12000);
        }
      } catch (searchErr) {
        console.warn("Exa search also failed:", searchErr);
      }
    }
  }

  if (!docText) {
    try {
      const resp = await fetch(docsUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15000),
      });
      const html = await resp.text();
      docText = html
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 12000);
    } catch (fetchErr) {
      throw new Error(`Could not fetch docs from ${docsUrl}: ${fetchErr}`);
    }
  }

  const anthropic = new Anthropic({ apiKey: anthropicApiKey });
  const prompt    = DOC_EXTRACTION_PROMPT.replace("{doc_text}", docText);

  const message = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const rawText =
    message.content[0].type === "text" ? message.content[0].text.trim() : "";
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```$/m, "")
    .replace(/\/\/[^\n]*/g, "")
    .trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Claude returned unparseable JSON:\n${rawText}`);
  }

  return {
    endpoint_url:  String(parsed.endpoint_url ?? ""),
    headers:       (parsed.headers as Record<string, string>) ?? { "Content-Type": "application/json" },
    body_template: (parsed.body_template as Record<string, unknown>) ?? {},
    model_id:      String(parsed.model_id ?? ""),
  };
}

export const resolveTemplateFromDocs = runDocReaderAgent;

// ── Template validation ────────────────────────────────────────────────────────

function substitutePlaceholders(s: string, apiKey: string, modelId: string, prompt: string): string {
  return s
    .replace(/\{api_key\}/g, apiKey)
    .replace(/\{model\}/g,   modelId)
    .replace(/\{prompt\}/g,  prompt);
}

function buildFetchOptions(
  template: RequestTemplate,
  apiKey: string,
  prompt: string
): { url: string; init: RequestInit } {
  const modelId = template.model_id ?? "";

  let url = substitutePlaceholders(
    template.endpoint_url || (template as any).url || "",
    apiKey, modelId, prompt
  );

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(template.headers ?? {})) {
    headers[substitutePlaceholders(k, apiKey, modelId, prompt)] =
      substitutePlaceholders(v, apiKey, modelId, prompt);
  }

  const authType = (template.auth_type ?? "bearer").toLowerCase();
  if (authType === "bearer" && apiKey) {
    headers["Authorization"] = headers["Authorization"] ?? `Bearer ${apiKey}`;
  } else if (authType === "query_param" && apiKey) {
    const param = template.auth_param_name ?? "api_key";
    url += url.includes("?") ? `&${param}=${apiKey}` : `?${param}=${apiKey}`;
  } else if (authType === "basic" && apiKey) {
    headers["Authorization"] = `Basic ${Buffer.from(`:${apiKey}`).toString("base64")}`;
  }

  const qp = template.query_params ?? {};
  if (Object.keys(qp).length > 0) {
    const qs = new URLSearchParams(qp).toString();
    url += url.includes("?") ? `&${qs}` : `?${qs}`;
  }

  const rawBodyStr = JSON.stringify(template.body_template ?? {});
  const body = JSON.parse(substitutePlaceholders(rawBodyStr, apiKey, modelId, prompt));

  headers["Content-Type"] = headers["Content-Type"] ?? "application/json";

  return {
    url,
    init: {
      method: (template.method ?? "POST").toUpperCase(),
      headers,
      body: JSON.stringify(body),
    },
  };
}

function extractResponseText(data: unknown): string {
  if (typeof data !== "object" || data === null) return String(data ?? "");
  const d = data as Record<string, unknown>;

  if (Array.isArray(d.choices) && d.choices.length > 0) {
    const msg = (d.choices[0] as any)?.message?.content;
    if (msg) return String(msg);
    const text = (d.choices[0] as any)?.text;
    if (text) return String(text);
  }
  if (Array.isArray(d.content) && d.content.length > 0) {
    const txt = (d.content[0] as any)?.text;
    if (txt) return String(txt);
  }
  if (Array.isArray(d.candidates) && d.candidates.length > 0) {
    const txt = (d.candidates[0] as any)?.content?.parts?.[0]?.text;
    if (txt) return String(txt);
  }
  if (typeof d.message === "object" && d.message !== null) {
    const content = (d.message as any)?.content;
    if (Array.isArray(content) && content.length > 0) return String(content[0]?.text ?? "");
    if (typeof content === "string") return content;
  }
  if (typeof d.response      === "string") return d.response;
  if (typeof d.generated_text === "string") return d.generated_text;
  if (typeof d.text          === "string") return d.text;
  if (typeof d.output        === "string") return d.output;
  if (typeof d.result        === "string") return d.result;
  if (typeof d.completion    === "string") return d.completion;

  return JSON.stringify(data).slice(0, 500);
}

export async function validateTemplate(
  template: RequestTemplate,
  apiKey: string
): Promise<{ ok: boolean; error?: string }> {
  const { url, init } = buildFetchOptions(template, apiKey, "Reply with just the word: PING");
  try {
    const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      return { ok: false, error: `HTTP ${resp.status}: ${errBody.slice(0, 300)}` };
    }
    const data = await resp.json();
    const text = extractResponseText(data);
    if (!text) return { ok: false, error: "Response contained no text content" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── FingerprintBatch ──────────────────────────────────────────────────────────

export async function runFingerprintBatch(params: {
  batchIndex: 0 | 1 | 2;
  template: RequestTemplate;
  apiKey: string;
}): Promise<BatchResult> {
  const { batchIndex, template, apiKey } = params;
  const start = batchIndex * 5;
  const batchPrompts = FINGERPRINT_PROMPTS.slice(start, start + 5);
  const responses: BatchResult["responses"] = [];

  for (const prompt of batchPrompts) {
    const t0 = Date.now();
    try {
      const { url, init } = buildFetchOptions(template, apiKey, prompt);
      const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
      const latency_ms = Date.now() - t0;
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        responses.push({ prompt, response: `ERROR HTTP ${resp.status}: ${errBody.slice(0, 200)}`, latency_ms });
        continue;
      }
      const data = await resp.json();
      responses.push({ prompt, response: extractResponseText(data), latency_ms });
    } catch (err) {
      responses.push({ prompt, response: `ERROR: ${String(err)}`, latency_ms: Date.now() - t0 });
    }
  }

  const lengths  = responses.map((r) => r.response.length);
  const avgLen   = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const avgLat   = responses.length > 0 ? responses.reduce((a, b) => a + b.latency_ms, 0) / responses.length : 0;
  const variance = lengths.length > 0 ? lengths.reduce((a, b) => a + (b - avgLen) ** 2, 0) / lengths.length : 0;

  const wordCounts: Record<string, number> = {};
  for (const r of responses) {
    for (const word of r.response.toLowerCase().match(/\b\w{4,}\b/g) ?? []) {
      wordCounts[word] = (wordCounts[word] ?? 0) + 1;
    }
  }
  const topVocab = Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w);

  return {
    batch_index: batchIndex,
    responses,
    partial_signature: {
      avg_response_length: Math.round(avgLen),
      std_response_length: Math.round(Math.sqrt(variance)),
      avg_latency_ms:      Math.round(avgLat),
      top_vocab:           topVocab,
      sample_count:        responses.length,
    },
  };
}

export async function fingerprintBatch(
  batchIndex: 0 | 1 | 2,
  apiEndpoint: string,
  apiKey: string,
  modelHint: string,
  template: RequestTemplate | null
): Promise<BatchResult> {
  const effectiveTemplate = template ?? buildDefaultTemplate(apiEndpoint, modelHint);
  return runFingerprintBatch({ batchIndex, template: effectiveTemplate, apiKey });
}

function buildDefaultTemplate(apiEndpoint: string, modelHint: string): RequestTemplate {
  const url = apiEndpoint.toLowerCase();

  if (url.includes("anthropic.com")) {
    const base     = apiEndpoint.replace(/\/+$/, "");
    const endpoint = base.endsWith("/messages") ? base : base.replace(/\/v1\/?$/, "") + "/v1/messages";
    return {
      endpoint_url:  endpoint,
      headers:       { "Content-Type": "application/json", "x-api-key": "{api_key}", "anthropic-version": "2023-06-01" },
      body_template: { model: modelHint || "claude-3-haiku-20240307", max_tokens: 512, messages: [{ role: "user", content: "{prompt}" }] },
      model_id:      modelHint || "claude-3-haiku-20240307",
      auth_type:     "header",
    };
  }

  if (url.includes("generativelanguage.googleapis.com")) {
    const model = modelHint || "gemini-1.5-flash";
    return {
      endpoint_url:  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers:       { "Content-Type": "application/json" },
      body_template: { contents: [{ parts: [{ text: "{prompt}" }] }] },
      model_id:      model,
      auth_type:     "query_param",
      auth_param_name: "key",
    };
  }

  if (url.includes("cohere.com") || url.includes("cohere.ai")) {
    return {
      endpoint_url:  "https://api.cohere.com/v2/chat",
      headers:       { "Content-Type": "application/json" },
      body_template: { model: modelHint || "command-r", messages: [{ role: "user", content: "{prompt}" }] },
      model_id:      modelHint || "command-r",
      auth_type:     "bearer",
    };
  }

  let base = apiEndpoint.replace(/\/+$/, "");
  if (!base.endsWith("/chat/completions")) {
    if (!base.includes("/v1")) base += "/v1";
    base += "/chat/completions";
  }

  let defaultModel = modelHint;
  if (!defaultModel) {
    if      (url.includes("groq.com"))                          defaultModel = "llama3-8b-8192";
    else if (url.includes("mistral.ai"))                        defaultModel = "mistral-small-latest";
    else if (url.includes("together.ai") || url.includes("together.xyz")) defaultModel = "meta-llama/Llama-3-8b-chat-hf";
    else if (url.includes("perplexity.ai"))                     defaultModel = "llama-3.1-sonar-small-128k-online";
    else if (url.includes("deepinfra.com"))                     defaultModel = "meta-llama/Meta-Llama-3-8B-Instruct";
    else if (url.includes("openrouter.ai"))                     defaultModel = "openai/gpt-4o-mini";
    else                                                        defaultModel = "gpt-4o-mini";
  }

  return {
    endpoint_url:  base,
    headers:       { "Content-Type": "application/json" },
    body_template: { model: "{model}", messages: [{ role: "user", content: "{prompt}" }], max_tokens: 512 },
    model_id:      defaultModel,
    auth_type:     "bearer",
  };
}

// ── SHA-256 behavior hash (kept as exact-match fast path) ────────────────────

export function computeBehaviorHash(allBatches: BatchResult[]): string {
  const sorted = [...allBatches.flatMap((b) => b.responses)].sort((a, b) =>
    a.prompt.localeCompare(b.prompt)
  );
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

// ── Legacy compareHash (Levenshtein on SHA256) — kept for backward compat ────
// NOTE: this gives meaningless similarity scores on hex strings.
// Real scoring is now done by compareFingerprintEmbeddings().

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
    }
  }
  return dp[m][n];
}

export function compareHash(hash: string, knownModels: KnownModel[]): CompareResult {
  const results = knownModels
    .filter((m) => m.behavior_hash)
    .map((m) => ({
      name:       m.name,
      similarity: 1 - levenshtein(hash, m.behavior_hash!) / Math.max(hash.length, m.behavior_hash!.length),
    }))
    .sort((a, b) => b.similarity - a.similarity);

  const top = results[0]?.similarity ?? 0;
  const verdict: CompareResult["verdict"] =
    top >= 0.99 ? "match" : top >= 0.9 ? "clone" : top >= 0.7 ? "suspicious" : "unknown";

  return { similar_models: results.slice(0, 5), verdict };
}

/** compareFingerprintHash — SHA-256 exact match fast path only. */
export async function compareFingerprintHash(
  behaviorHash: string
): Promise<{ similar_models: { name: string; similarity: number; source?: string }[]; verdict: string }> {
  try {
    const { db, known_models } = await import("../db/index.js");
    const rows = await db.select().from(known_models);
    const result = compareHash(behaviorHash, rows.map((r: any) => ({
      name: r.name, behavior_hash: r.fingerprint_hash ?? null,
    })));
    return {
      similar_models: result.similar_models.map((m) => ({ ...m, source: "known_models" })),
      verdict: result.verdict,
    };
  } catch (err) {
    console.warn("compareFingerprintHash: DB query failed:", err);
    return { similar_models: [], verdict: "unknown" };
  }
}
