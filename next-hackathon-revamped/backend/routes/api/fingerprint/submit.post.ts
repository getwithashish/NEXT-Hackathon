/**
 * POST /api/fingerprint/submit
 * Starts a fingerprint-on-demand workflow.
 * Body: { api_endpoint, api_key, model_name?, model_hint?, doc_url?, request_template? }
 */
import { defineEventHandler, readBody, setHeader } from "h3";
import { start } from "workflow/api";
import { fingerprintOnDemandWorkflow } from "../../../workflows/fingerprint-on-demand.js";
import { db, fingerprints } from "../../../lib/db/index.js";
import crypto from "node:crypto";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  const body = await readBody(event) as any;
  const { api_endpoint, api_key, model_name, model_hint, doc_url, request_template } = body ?? {};

  if (!api_endpoint || !api_key) {
    event.node.res.statusCode = 400;
    return { error: "api_endpoint and api_key are required" };
  }

  const jobId = crypto.randomUUID();

  // Create pending DB record before starting workflow
  await db.insert(fingerprints).values({
    job_id: jobId,
    workflow_run_id: null,
    model_name: model_name ?? "unknown",
    model_type: "api",
    status: "pending",
    source: "on_demand",
    step_events: [],
  });

  const run = await start(fingerprintOnDemandWorkflow, [
    jobId,
    api_endpoint,
    api_key,
    model_name ?? "unknown",
    model_hint ?? "",
    doc_url,
    request_template,
  ]);

  // Update record with runId
  await db
    .update(fingerprints)
    .set({ workflow_run_id: run.runId, status: "running" })
    .where((t: any) => t.job_id.eq(jobId));

  return { job_id: jobId, run_id: run.runId, status: "started" };
});
