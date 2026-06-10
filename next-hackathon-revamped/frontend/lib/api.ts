export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export async function submitFingerprint(body: {
  api_endpoint: string;
  api_key: string;
  model_name?: string;
  model_hint?: string;
  doc_url?: string;
}) {
  const res = await fetch(`${API_URL}/api/fingerprint/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ job_id: string; run_id: string; status: string }>;
}

export async function getWorkflowStatus(runId: string) {
  const res = await fetch(`${API_URL}/api/fingerprint/status/${runId}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{
    run_id: string;
    status: string;
    step_events: Array<{ type: string; step_name?: string; timestamp: string }>;
    result?: any;
  }>;
}

export async function getPendingApprovals() {
  const res = await fetch(`${API_URL}/api/approval/pending`);
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
  const res = await fetch(`${API_URL}/api/approval/decide/${providerId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved, api_key: apiKey }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getJobs(limit = 20) {
  const res = await fetch(`${API_URL}/api/jobs?limit=${limit}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ jobs: any[] }>;
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

export async function getSimilarFingerprints(jobId: string) {
  const res = await fetch(`${API_URL}/api/fingerprint/${jobId}/similar`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ job_id: string; similar: SimilarFingerprint[] }>;
}
