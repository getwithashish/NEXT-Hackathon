import { defineEventHandler } from "h3";

export default defineEventHandler(async () => {
  return {
    ok: true,
    env: {
      has_db_url: !!process.env.DATABASE_URL,
      has_exa: !!process.env.EXA_API_KEY,
      has_aws: !!process.env.AWS_ACCESS_KEY_ID,
      node_version: process.version,
    }
  };
});
