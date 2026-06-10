import { defineEventHandler } from "h3";

export default defineEventHandler(async () => {
  return {
    ok: true,
    env: {
      has_db_url: !!process.env.DATABASE_URL,
      has_exa: !!process.env.EXA_API_KEY,
      has_aws: !!process.env.AWS_ACCESS_KEY_ID,
      has_workflow_server_url: !!process.env.VERCEL_WORKFLOW_SERVER_URL,
      has_workflow_auth_token: !!process.env.WORKFLOW_VERCEL_AUTH_TOKEN,
      has_vercel_oidc_token: !!process.env.VERCEL_OIDC_TOKEN,
      workflow_server_url: process.env.VERCEL_WORKFLOW_SERVER_URL ?? null,
      node_version: process.version,
    }
  };
});
