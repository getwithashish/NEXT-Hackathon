import { defineEventHandler, readBody, setHeader } from "h3";
import { start } from "workflow/api";
import { contentReviewWorkflow } from "../../workflows/content-review.js";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  setHeader(event, "Access-Control-Allow-Headers", "Content-Type");
  const { content, author } = await readBody(event) || {};
  if (!content) {
    event.node.res.statusCode = 400;
    return { error: "content is required" };
  }

  const jobId = crypto.randomUUID().slice(0, 8);
  const run = await start(contentReviewWorkflow, [jobId, content, author || "anonymous"]);

  return { jobId, runId: run.runId, status: "started" };
});