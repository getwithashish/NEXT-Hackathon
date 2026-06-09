import { defineEventHandler, setHeader } from "h3";

export default defineEventHandler((event) => {
  setHeader(event, "Access-Control-Allow-Origin", "*");
  setHeader(event, "Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  setHeader(event, "Access-Control-Allow-Headers", "Content-Type");
  event.node.res.statusCode = 204;
  return null;
});