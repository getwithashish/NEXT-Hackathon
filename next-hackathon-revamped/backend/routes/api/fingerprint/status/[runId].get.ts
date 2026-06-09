/**
 * GET /api/fingerprint/status/:runId
 * Returns current workflow run status + step events stream for the frontend.
 * Uses getRun(runId).readable to get real step events — NOT time-based.
 */
import { defineEventHandler, setHeader, getRouterParam } from "h3";
import { getRun } from "workflow/api";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  const runId = getRouterParam(event, "runId");
  if (!runId) {
    event.node.res.statusCode = 400;
    return { error: "runId required" };
  }

  const run = getRun(runId);
  const status = await run.status;

  // Collect step events from the readable stream
  // This gives REAL per-step state — not time-based estimates
  const stepEvents: Array<{ type: string; step_name?: string; timestamp: string }> = [];
  try {
    const reader = run.readable.getReader();
    // Read all available events without blocking (non-blocking drain)
    while (true) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), 100)
        ),
      ]);
      if (done || !value) break;
      stepEvents.push({ ...value, timestamp: new Date().toISOString() });
    }
    reader.releaseLock();
  } catch {
    // readable may not be available in local world — degrade gracefully
  }

  let result = null;
  if (status === "completed") {
    try { result = await run.returnValue; } catch {}
  }

  return { run_id: runId, status, step_events: stepEvents, result };
});
