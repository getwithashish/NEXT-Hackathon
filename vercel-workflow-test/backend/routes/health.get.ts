import { defineEventHandler } from "h3";

export default defineEventHandler(() => {
  return { ok: true, ts: new Date().toISOString() };
});