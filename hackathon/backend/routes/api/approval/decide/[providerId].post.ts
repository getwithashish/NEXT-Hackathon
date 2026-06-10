/**
 * POST /api/approval/decide/:providerId
 * Called when user clicks Approve (with api_key) or Skip in the frontend.
 * Resumes the payment-approval workflow HIL hook.
 *
 * Body: { approved: boolean, api_key: string }
 */
import { defineEventHandler, readBody, setHeader, getRouterParam } from "h3";
import { resumeHook } from "workflow/api";

export default defineEventHandler(async (event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  setHeader(event, "Access-Control-Allow-Headers", "Content-Type");

  const providerId = getRouterParam(event, "providerId");
  const body = await readBody(event) as any;
  const { approved, api_key } = body ?? {};

  if (!providerId) {
    event.node.res.statusCode = 400;
    return { error: "providerId required" };
  }
  if (approved && !api_key?.trim()) {
    event.node.res.statusCode = 400;
    return { error: "api_key is required when approving" };
  }

  try {
    await resumeHook(`approval:${providerId}`, {
      approved: Boolean(approved),
      api_key: api_key ?? "",
    });
    return { ok: true, provider_id: providerId, approved };
  } catch (err: any) {
    event.node.res.statusCode = 500;
    return { error: err.message };
  }
});
