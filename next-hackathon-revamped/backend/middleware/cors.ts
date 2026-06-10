import { defineEventHandler, setResponseHeaders } from "h3";

/**
 * Global CORS middleware.
 *
 * For OPTIONS preflight: return a native Response directly.
 * h3 v2 treats a returned Response as the final response, stopping
 * the handler chain before the Vercel Workflow SDK handlers ever run.
 *
 * For all other methods: append CORS headers and pass through.
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

export default defineEventHandler((event) => {
  if (event.method === "OPTIONS") {
    // Return a Response object — h3 v2 passes it through prepareResponse()
    // which returns it as-is (non-undefined, non-kNotFound), short-circuiting
    // any further middleware or route handlers including the Workflow SDK.
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Non-preflight: add CORS headers to the ongoing response
  setResponseHeaders(event, CORS_HEADERS);
});
