/**
 * workflows/payment-approval.ts
 *
 * Triggered by: EC2 crawler POSTs to /api/approval/start
 *   when a provider requires an API key and human action.
 *
 * Steps:
 *   1. persist-for-review  — write provider to DB with status "needs_api_key"
 *   2. ── HIL PAUSE ──     — workflow suspends until user enters API key + approves
 *                            The frontend shows a card with:
 *                              - provider name, docs URL, pricing URL
 *                              - text input: "Enter API key"  (Approve disabled until filled)
 *                              - Approve / Skip buttons
 *   3. process-approval    — save api_key to provider, update status to "approved"
 *   4. trigger-fingerprint — POST to /api/fingerprint/crawl-start to kick off
 *                            the crawl-fingerprint workflow for this provider
 *
 * Hook token: `approval:${providerId}` — used by the frontend to resume.
 */

import { createHook } from "workflow";
import { db, providers } from "../lib/db/index.js";
import { eq } from "drizzle-orm";

// ── Step 1 ────────────────────────────────────────────────────────────────────

async function stepPersistForReview(
  providerId: string,
  providerName: string,
  docsUrl: string | null,
  pricingUrl: string | null,
  modelIds: string[]
) {
  "use step";
  await db
    .update(providers)
    .set({ status: "needs_api_key", updated_at: new Date() })
    .where(eq(providers.id, providerId));

  return {
    provider_id: providerId,
    provider_name: providerName,
    docs_url: docsUrl,
    pricing_url: pricingUrl,
    model_ids: modelIds,
    persisted_at: new Date().toISOString(),
  };
}

// ── Step 3 ────────────────────────────────────────────────────────────────────

async function stepProcessApproval(
  providerId: string,
  apiKey: string,
  approved: boolean
) {
  "use step";
  if (!approved) {
    await db
      .update(providers)
      .set({ status: "skipped", updated_at: new Date() })
      .where(eq(providers.id, providerId));
    return { approved: false, provider_id: providerId };
  }

  await db
    .update(providers)
    .set({
      status: "approved",
      api_key: apiKey,
      approval_run_id: null,
      updated_at: new Date(),
    })
    .where(eq(providers.id, providerId));

  return { approved: true, provider_id: providerId, api_key: apiKey };
}

// ── Step 4 ────────────────────────────────────────────────────────────────────

async function stepTriggerFingerprint(
  providerId: string,
  providerName: string,
  apiKey: string,
  docsUrl: string | null,
  modelIds: string[]
) {
  "use step";
  // POST to the crawl-fingerprint workflow start endpoint (same Nitro server)
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3001";

  const res = await fetch(`${baseUrl}/api/fingerprint/crawl-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider_id: providerId,
      provider_name: providerName,
      api_key: apiKey,
      docs_url: docsUrl,
      model_ids: modelIds,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to start crawl-fingerprint: ${await res.text()}`);
  }

  const data = await res.json() as { run_ids: string[] };
  return { crawl_run_ids: data.run_ids };
}

// ── Main workflow ─────────────────────────────────────────────────────────────

export async function paymentApprovalWorkflow(
  providerId: string,
  providerName: string,
  docsUrl: string | null,
  pricingUrl: string | null,
  modelIds: string[]
) {
  "use workflow";

  // Step 1: mark as needs_api_key in DB
  const reviewInfo = await stepPersistForReview(
    providerId, providerName, docsUrl, pricingUrl, modelIds
  );

  // Step 2: HIL — suspend until user enters API key and clicks Approve
  // The frontend reads pending approvals from the DB and calls
  // POST /api/approval/decide/:providerId to resume this hook.
  using hook = createHook<{ approved: boolean; api_key: string }>({
    token: `approval:${providerId}`,
  });

  const decision = await hook;

  // Step 3: save decision to DB
  const approval = await stepProcessApproval(
    providerId,
    decision.api_key,
    decision.approved
  );

  if (!approval.approved) {
    return { status: "skipped", provider_id: providerId };
  }

  // Step 4: kick off fingerprinting for each model
  const fingerprint = await stepTriggerFingerprint(
    providerId,
    providerName,
    decision.api_key,
    docsUrl,
    modelIds
  );

  return {
    status: "approved_and_queued",
    provider_id: providerId,
    provider_name: providerName,
    crawl_run_ids: fingerprint.crawl_run_ids,
  };
}
