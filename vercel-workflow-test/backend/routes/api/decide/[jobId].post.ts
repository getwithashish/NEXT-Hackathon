import { defineEventHandler, readBody, setHeader, getRouterParam } from "h3";
import { resumeHook } from "workflow/api";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  setHeader(event, "Access-Control-Allow-Headers", "Content-Type");
  const jobId = getRouterParam(event, "jobId");
  const body: any = await readBody(event) || {};
  if (!jobId) {
    event.node.res.statusCode = 400;
    return { error: "jobId required" };
  }

  const hook = await resumeHook(`review:${jobId}`, { approved: body.approved, note: body.note });
  return { ok: true, hookId: (hook as any).id };
});