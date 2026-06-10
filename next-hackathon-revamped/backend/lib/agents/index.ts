/**
 * lib/agents/index.ts
 *
 * Native TypeScript agent implementations — runs on Vercel (Nitro), NO EC2 calls.
 *
 * Exports (used by workflows):
 *   resolveTemplateFromDocs  — alias for runDocReaderAgent (backward compat)
 *   validateTemplate         — single test call to verify a template
 *   fingerprintBatch         — alias for runFingerprintBatch (backward compat)
 *   compareFingerprintHash   — alias for compareHash (backward compat)
 *   computeBehaviorHash      — SHA-256 hash of all batch responses
 *   runDocReaderAgent        — Exa + Claude → RequestTemplate
 *   runFingerprintBatch      — send 5 prompts, record latency
 *   compareHash              — Levenshtein comparison against known models
 */

import Anthropic from "@anthropic-ai/sdk";
import Exa from "exa-js";
import crypto from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RequestTemplate {
  /** Full endpoint URL; may contain {api_key} or {model} placeholders */
  endpoint_url: string;
  /** HTTP headers dict; {api_key} placeholder will be substituted */
  headers: Record<string, string>;
  /** JSON body template; {prompt}, {api_key}, {model} will be substituted */
  body_template: Record<string, unknown>;
  /** Model ID / hint, e.g. "gpt-4o-mini" */
  model_id: string;
  // Legacy / extended fields carried for backward-compat with workflows
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
  /** Partial signature for backward compat with existing workflow code */
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

// Legacy type kept for workflow compat
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

// ── Behavioral probe prompts (same 15 as Python agent) ────────────────────────

const FINGERPRINT_PROMPTS = [
  "Tell me a joke",
  "What is 2+2?",
  "Summarize the French Revolution in one sentence",
  "Write a haiku about rain",
  "What is the capital of Australia?",
  "Explain recursion like I am 5",
  "List 3 uses of a paper clip",
  "What color is the sky?",
  "Translate hello to Spanish",
  "What is the boiling point of water?",
  "Name a planet in our solar system",
  "What is the speed of light?",
  "Write a limerick about a cat",
  "What is 15% of 200?",
  "Who painted the Mona Lisa?",
];

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

/**
 * runDocReaderAgent — fetch a doc URL via Exa, then use Claude to extract
 * a RequestTemplate describing how to call that provider's API.
 */
export async function runDocReaderAgent(
  docsUrl: string,
  _apiKey: string
): Promise<RequestTemplate> {
  const exaApiKey = process.env.EXA_API_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY env var not set");
  }

  // ── Step 1: fetch doc text via Exa ─────────────────────────────────────────
  let docText = "";

  if (exaApiKey) {
    try {
      const exa = new Exa(exaApiKey);
      // Try getContents first (fetch a specific URL)
      const contentsResult = await (exa as any).getContents([docsUrl], {
        text: true,
        highlights: false,
      });
      const results = contentsResult?.results ?? contentsResult ?? [];
      if (Array.isArray(results) && results.length > 0 && results[0]?.text) {
        docText = (results[0].text as string).slice(0, 12000);
      }
    } catch (exaErr) {
      console.warn("Exa getContents failed, trying search:", exaErr);
      // Fall back to search
      try {
        const exa = new Exa(exaApiKey);
        const searchResult = await exa.search(
          `${docsUrl} API documentation chat completions`,
          { numResults: 5, type: "auto" }
        );
        const searchResults = searchResult?.results ?? [];
        if (searchResults.length > 0) {
          docText = searchResults
            .map((r: any) =>
              `### ${r.title ?? ""}\nURL: ${r.url ?? ""}\n${r.text ?? ""}`
            )
            .join("\n\n")
            .slice(0, 12000);
        }
      } catch (searchErr) {
        console.warn("Exa search also failed:", searchErr);
      }
    }
  }

  // Fallback: plain HTTP fetch if Exa gave us nothing
  if (!docText) {
    try {
      const resp = await fetch(docsUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15000),
      });
      const html = await resp.text();
      // Strip HTML tags
      docText = html
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 12000);
    } catch (fetchErr) {
      throw new Error(
        `Could not fetch docs from ${docsUrl}: ${fetchErr}`
      );
    }
  }

  // ── Step 2: Claude extraction ──────────────────────────────────────────────
  const anthropic = new Anthropic({ apiKey: anthropicApiKey });
  const prompt = DOC_EXTRACTION_PROMPT.replace("{doc_text}", docText);

  const message = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const rawText =
    message.content[0].type === "text" ? message.content[0].text.trim() : "";

  // Strip markdown code fences if present
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```$/m, "")
    // Strip JS-style comments
    .replace(/\/\/[^\n]*/g, "")
    .trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `Claude returned unparseable JSON for doc extraction:\n${rawText}`
    );
  }

  return {
    endpoint_url: String(parsed.endpoint_url ?? ""),
    headers: (parsed.headers as Record<string, string>) ?? {
      "Content-Type": "application/json",
    },
    body_template: (parsed.body_template as Record<string, unknown>) ?? {},
    model_id: String(parsed.model_id ?? ""),
  };
}

/** Backward-compat alias used by workflows */
export const resolveTemplateFromDocs = runDocReaderAgent;

// ── Template validation (CustomTemplateCallerAgent) ───────────────────────────

/**
 * Substitute {api_key}, {model}, {prompt} placeholders in a string.
 */
function substitutePlaceholders(
  s: string,
  apiKey: string,
  modelId: string,
  prompt: string
): string {
  return s
    .replace(/\{api_key\}/g, apiKey)
    .replace(/\{model\}/g, modelId)
    .replace(/\{prompt\}/g, prompt);
}

/**
 * Build fetch options from a RequestTemplate + apiKey + prompt.
 */
function buildFetchOptions(
  template: RequestTemplate,
  apiKey: string,
  prompt: string
): { url: string; init: RequestInit } {
  const modelId = template.model_id ?? "";

  // Substitute URL placeholders
  let url = substitutePlaceholders(
    template.endpoint_url || (template as any).url || "",
    apiKey,
    modelId,
    prompt
  );

  // Build headers
  const headers: Record<string, string> = {};
  const rawHeaders = template.headers ?? {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    headers[substitutePlaceholders(k, apiKey, modelId, prompt)] =
      substitutePlaceholders(v, apiKey, modelId, prompt);
  }

  // Apply auth_type (default: bearer)
  const authType = (template.auth_type ?? "bearer").toLowerCase();
  if (authType === "bearer" && apiKey) {
    headers["Authorization"] = headers["Authorization"] ?? `Bearer ${apiKey}`;
  } else if (authType === "query_param" && apiKey) {
    const param = template.auth_param_name ?? "api_key";
    url += url.includes("?") ? `&${param}=${apiKey}` : `?${param}=${apiKey}`;
  } else if (authType === "basic" && apiKey) {
    const creds = Buffer.from(`:${apiKey}`).toString("base64");
    headers["Authorization"] = `Basic ${creds}`;
  }

  // Append query_params
  const qp = template.query_params ?? {};
  if (Object.keys(qp).length > 0) {
    const qs = new URLSearchParams(qp).toString();
    url += url.includes("?") ? `&${qs}` : `?${qs}`;
  }

  // Build body
  const rawBodyStr = JSON.stringify(template.body_template ?? {});
  const bodyStr = substitutePlaceholders(rawBodyStr, apiKey, modelId, prompt);
  const body = JSON.parse(bodyStr);

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

/**
 * Try to extract the text response from a common set of JSON response shapes.
 * Mirrors _discover_response_path / _extract_text logic from the Python agent.
 */
function extractResponseText(data: unknown): string {
  if (typeof data !== "object" || data === null) return String(data ?? "");
  const d = data as Record<string, unknown>;

  // OpenAI / compat
  if (Array.isArray(d.choices) && d.choices.length > 0) {
    const msg = (d.choices[0] as any)?.message?.content;
    if (msg) return String(msg);
    // older completions
    const text = (d.choices[0] as any)?.text;
    if (text) return String(text);
  }
  // Anthropic
  if (Array.isArray(d.content) && d.content.length > 0) {
    const txt = (d.content[0] as any)?.text;
    if (txt) return String(txt);
  }
  // Google Gemini
  if (Array.isArray(d.candidates) && d.candidates.length > 0) {
    const txt = (d.candidates[0] as any)?.content?.parts?.[0]?.text;
    if (txt) return String(txt);
  }
  // Cohere v2
  if (typeof d.message === "object" && d.message !== null) {
    const content = (d.message as any)?.content;
    if (Array.isArray(content) && content.length > 0) {
      const txt = content[0]?.text;
      if (txt) return String(txt);
    }
    if (typeof content === "string") return content;
  }
  // Ollama native
  if (typeof d.response === "string") return d.response;
  // HuggingFace
  if (typeof d.generated_text === "string") return d.generated_text;
  // Generic
  if (typeof d.text === "string") return d.text;
  if (typeof d.output === "string") return d.output;
  if (typeof d.result === "string") return d.result;
  if (typeof d.completion === "string") return d.completion;

  return JSON.stringify(data).slice(0, 500);
}

/**
 * validateTemplate — makes a single test call to the endpoint.
 * Returns { ok: true } on success, { ok: false, error } on failure.
 */
export async function validateTemplate(
  template: RequestTemplate,
  apiKey: string
): Promise<{ ok: boolean; error?: string }> {
  const testPrompt = "Reply with just the word: PING";
  const { url, init } = buildFetchOptions(template, apiKey, testPrompt);

  try {
    const resp = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      return { ok: false, error: `HTTP ${resp.status}: ${errBody.slice(0, 300)}` };
    }
    const data = await resp.json();
    const text = extractResponseText(data);
    if (!text) {
      return { ok: false, error: "Response contained no text content" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── FingerprintBatch ───────────────────────────────────────────────────────────

/**
 * runFingerprintBatch — send 5 prompts (one batch of 3) to the endpoint.
 *
 * batchIndex 0 → prompts 0–4
 * batchIndex 1 → prompts 5–9
 * batchIndex 2 → prompts 10–14
 */
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
      const resp = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(30000),
      });
      const latency_ms = Date.now() - t0;

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        responses.push({
          prompt,
          response: `ERROR HTTP ${resp.status}: ${errBody.slice(0, 200)}`,
          latency_ms,
        });
        continue;
      }

      const data = await resp.json();
      const text = extractResponseText(data);
      responses.push({ prompt, response: text, latency_ms });
    } catch (err) {
      const latency_ms = Date.now() - t0;
      responses.push({
        prompt,
        response: `ERROR: ${String(err)}`,
        latency_ms,
      });
    }
  }

  // Compute partial signature for backward compat with existing workflow code
  const lengths = responses.map((r) => r.response.length);
  const avgLen =
    lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const avgLatency =
    responses.length > 0
      ? responses.reduce((a, b) => a + b.latency_ms, 0) / responses.length
      : 0;
  const variance =
    lengths.length > 0
      ? lengths.reduce((a, b) => a + Math.pow(b - avgLen, 2), 0) / lengths.length
      : 0;
  const stdLen = Math.sqrt(variance);

  // Top vocab: simple word frequency
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
      std_response_length: Math.round(stdLen),
      avg_latency_ms: Math.round(avgLatency),
      top_vocab: topVocab,
      sample_count: responses.length,
    },
  };
}

/**
 * Backward-compat alias: old workflows call
 *   fingerprintBatch(batchIndex, apiEndpoint, apiKey, modelHint, template)
 *
 * We route to runFingerprintBatch, using template if provided (or building a
 * minimal fallback template from the endpoint + modelHint).
 */
export async function fingerprintBatch(
  batchIndex: 0 | 1 | 2,
  apiEndpoint: string,
  apiKey: string,
  modelHint: string,
  template: RequestTemplate | null
): Promise<BatchResult> {
  // Build a minimal default OpenAI-compatible template if none was supplied
  const effectiveTemplate: RequestTemplate = template ?? buildDefaultTemplate(apiEndpoint, modelHint);
  return runFingerprintBatch({ batchIndex, template: effectiveTemplate, apiKey });
}

/**
 * Build a minimal OpenAI-compatible template from a bare endpoint URL.
 * Mirrors the heuristic provider detection in the Python ApiCallerAgent.
 */
function buildDefaultTemplate(apiEndpoint: string, modelHint: string): RequestTemplate {
  const url = apiEndpoint.toLowerCase();

  // Anthropic
  if (url.includes("anthropic.com")) {
    const base = apiEndpoint.replace(/\/+$/, "");
    const endpoint = base.endsWith("/messages") ? base : base.replace(/\/v1\/?$/, "") + "/v1/messages";
    return {
      endpoint_url: endpoint,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "{api_key}",
        "anthropic-version": "2023-06-01",
      },
      body_template: {
        model: modelHint || "claude-3-haiku-20240307",
        max_tokens: 512,
        messages: [{ role: "user", content: "{prompt}" }],
      },
      model_id: modelHint || "claude-3-haiku-20240307",
      auth_type: "header",
    };
  }

  // Google Gemini
  if (url.includes("generativelanguage.googleapis.com")) {
    const model = modelHint || "gemini-1.5-flash";
    return {
      endpoint_url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { "Content-Type": "application/json" },
      body_template: {
        contents: [{ parts: [{ text: "{prompt}" }] }],
      },
      model_id: model,
      auth_type: "query_param",
      auth_param_name: "key",
    };
  }

  // Cohere
  if (url.includes("cohere.com") || url.includes("cohere.ai")) {
    return {
      endpoint_url: "https://api.cohere.com/v2/chat",
      headers: { "Content-Type": "application/json" },
      body_template: {
        model: modelHint || "command-r",
        messages: [{ role: "user", content: "{prompt}" }],
      },
      model_id: modelHint || "command-r",
      auth_type: "bearer",
    };
  }

  // Default: OpenAI-compatible (works for OpenAI, Groq, Mistral, Together, Perplexity, DeepInfra, OpenRouter, etc.)
  let base = apiEndpoint.replace(/\/+$/, "");
  if (!base.endsWith("/chat/completions")) {
    if (!base.includes("/v1")) base = base + "/v1";
    base = base + "/chat/completions";
  }

  // Pick a sensible default model based on host
  let defaultModel = modelHint;
  if (!defaultModel) {
    if (url.includes("groq.com")) defaultModel = "llama3-8b-8192";
    else if (url.includes("mistral.ai")) defaultModel = "mistral-small-latest";
    else if (url.includes("together.ai") || url.includes("together.xyz"))
      defaultModel = "meta-llama/Llama-3-8b-chat-hf";
    else if (url.includes("perplexity.ai"))
      defaultModel = "llama-3.1-sonar-small-128k-online";
    else if (url.includes("deepinfra.com"))
      defaultModel = "meta-llama/Meta-Llama-3-8B-Instruct";
    else if (url.includes("openrouter.ai")) defaultModel = "openai/gpt-4o-mini";
    else defaultModel = "gpt-4o-mini";
  }

  return {
    endpoint_url: base,
    headers: { "Content-Type": "application/json" },
    body_template: {
      model: "{model}",
      messages: [{ role: "user", content: "{prompt}" }],
      max_tokens: 512,
    },
    model_id: defaultModel,
    auth_type: "bearer",
  };
}

// ── Behavior hash ──────────────────────────────────────────────────────────────

/**
 * computeBehaviorHash — flatten all responses, sort, SHA-256.
 */
export function computeBehaviorHash(allBatches: BatchResult[]): string {
  const allResponses = allBatches.flatMap((b) => b.responses);
  const sorted = [...allResponses].sort((a, b) =>
    a.prompt.localeCompare(b.prompt)
  );
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

// ── Levenshtein similarity ────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n];
}

function stringSimilarity(a: string, b: string): number {
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * compareHash — compare a behavior hash against known models.
 */
export function compareHash(
  hash: string,
  knownModels: KnownModel[]
): CompareResult {
  const results: { name: string; similarity: number }[] = [];

  for (const model of knownModels) {
    if (!model.behavior_hash) continue;
    const sim = stringSimilarity(hash, model.behavior_hash);
    results.push({ name: model.name, similarity: sim });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  const topSimilar = results.slice(0, 5);

  let verdict: CompareResult["verdict"] = "unknown";
  if (topSimilar.length > 0) {
    const top = topSimilar[0].similarity;
    if (top >= 0.99) verdict = "match";
    else if (top >= 0.9) verdict = "clone";
    else if (top >= 0.7) verdict = "suspicious";
    else verdict = "unknown";
  }

  return { similar_models: topSimilar, verdict };
}

/**
 * compareFingerprintHash — backward-compat alias used by existing workflows.
 * Queries known_models from the DB, then delegates to compareHash.
 */
export async function compareFingerprintHash(
  behaviorHash: string
): Promise<{ similar_models: { name: string; similarity: number; source?: string; from?: string }[]; verdict: string }> {
  // Lazy-import DB to avoid bundling issues in edge contexts
  try {
    const dbModule = await import("../db/index.js");
    const { db, known_models } = dbModule;
    const rows = await db.select().from(known_models);

    const models: KnownModel[] = rows.map((r: any) => ({
      name: r.name,
      behavior_hash: r.fingerprint_hash ?? null,
    }));

    const result = compareHash(behaviorHash, models);
    return {
      similar_models: result.similar_models.map((m) => ({
        ...m,
        source: "known_models",
        from: "db",
      })),
      verdict: result.verdict,
    };
  } catch (err) {
    console.warn("compareFingerprintHash: DB query failed:", err);
    // Return a safe default if DB is unavailable
    return { similar_models: [], verdict: "unknown" };
  }
}
