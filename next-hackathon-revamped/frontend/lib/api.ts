export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// ── No-store fetch helper (avoids stale Next.js caches) ──────────────────────
function noStore(url: string, init?: RequestInit) {
  return fetch(url, { cache: "no-store", ...init });
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface Job {
  job_id: string;
  workflow_run_id?: string | null;
  model_name?: string | null;
  model_type?: string;
  status: string;
  source?: string;
  verdict?: string | null;
  similarity_score?: number | null;
  matched_model?: string | null;
  fingerprint_hash?: string | null;
  created_at: string;
  completed_at?: string | null;
  step_events?: any[];
}

export interface JobsResult {
  jobs: Job[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface SimilarFingerprint {
  job_id: string;
  model_name: string | null;
  provider_name: string | null;
  similarity_score: number;
  verdict: string | null;
  source: string | null;
  completed_at: string | null;
}

// ── API functions ─────────────────────────────────────────────────────────────

export async function submitFingerprint(body: {
  api_endpoint: string;
  api_key: string;
  model_name?: string;
  model_hint?: string;
  doc_url?: string;
}) {
  const res = await noStore(`${API_URL}/api/fingerprint/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ job_id: string; run_id: string; status: string }>;
}

export async function getWorkflowStatus(runId: string) {
  const res = await noStore(`${API_URL}/api/fingerprint/status/${runId}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{
    run_id: string;
    status: string;
    step_events: Array<{ type: string; step_name?: string; timestamp: string }>;
    result?: any;
  }>;
}

export async function getPendingApprovals() {
  const res = await noStore(`${API_URL}/api/approval/pending`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ pending: Array<{
    id: string;
    name: string;
    docs_url: string | null;
    pricing_url: string | null;
    status: string;
    discovered_at: string;
  }> }>;
}

export async function decideApproval(providerId: string, approved: boolean, apiKey: string) {
  const res = await noStore(`${API_URL}/api/approval/decide/${providerId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved, api_key: apiKey }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getJobs(opts: {
  limit?: number;
  page?: number;
  status?: string;
  verdict?: string;
} = {}): Promise<JobsResult> {
  const { limit = 20, page = 1, status, verdict } = opts;
  const params = new URLSearchParams({ limit: String(limit), page: String(page) });
  if (status  && status  !== "all") params.set("status",  status);
  if (verdict && verdict !== "all") params.set("verdict", verdict);
  const res = await noStore(`${API_URL}/api/jobs?${params}`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  // Backwards-compat: old API returns { jobs: [] } without pagination fields
  return {
    jobs:  data.jobs  ?? [],
    total: data.total ?? data.jobs?.length ?? 0,
    page:  data.page  ?? 1,
    limit: data.limit ?? limit,
    pages: data.pages ?? 1,
  };
}

export async function getSimilarFingerprints(jobId: string) {
  const res = await noStore(`${API_URL}/api/fingerprint/${jobId}/similar`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ job_id: string; similar: SimilarFingerprint[] }>;
}

export async function getStats() {
  const res = await noStore(`${API_URL}/api/stats`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
