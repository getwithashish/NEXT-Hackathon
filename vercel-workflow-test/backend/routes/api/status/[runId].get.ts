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
  // Run.status is a Promise getter
  const status = await run.status;
  // Try to get result if completed
  let result = null;
  if (status === "completed") {
    try { result = await run.returnValue; } catch {}
  }
  return { runId, status, result };
});