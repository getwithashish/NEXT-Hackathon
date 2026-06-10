import { defineEventHandler, setResponseHeaders, getMethod } from "h3";

export default defineEventHandler((event) => {
  setResponseHeaders(event, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  });

  // Handle preflight OPTIONS immediately — no further processing needed
  if (getMethod(event) === "OPTIONS") {
    event.node?.res?.writeHead(204);
    event.node?.res?.end();
  }
});
