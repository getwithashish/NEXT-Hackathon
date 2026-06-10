/**
 * db/schema.ts — Unified Neon Postgres schema.
 *
 * v1.1 changes:
 *   - fingerprints.embedding_vectors  — JSONB array of 15 × 1024 Bedrock Titan floats
 *   - fingerprints.mean_vector        — 1024-float mean for fast pre-filter
 *   - fingerprints.similarity_score   — float [0,1] cosine similarity vs best match
 *   - fingerprints.matched_model      — name of best-matched known model
 *   - known_models.embedding_vectors  — same structure as fingerprints
 *   - known_models.mean_vector        — same
 */

import { pgTable, text, boolean, timestamp, jsonb, real, uuid } from "drizzle-orm/pg-core";

// ── Providers ─────────────────────────────────────────────────────────────────

export const providers = pgTable("providers", {
  id:               uuid("id").primaryKey().defaultRandom(),
  name:             text("name").notNull(),
  base_url:         text("base_url"),
  docs_url:         text("docs_url"),
  pricing_url:      text("pricing_url"),
  free_tier:        boolean("free_tier").notNull().default(false),
  requires_payment: boolean("requires_payment").notNull().default(false),
  status:           text("status").notNull().default("discovered"),
  api_key:          text("api_key"),
  approval_run_id:  text("approval_run_id"),
  notes:            text("notes"),
  discovered_at:    timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:       timestamp("updated_at",    { withTimezone: true }).notNull().defaultNow(),
});

// ── Accounts ──────────────────────────────────────────────────────────────────

export const accounts = pgTable("accounts", {
  id:                uuid("id").primaryKey().defaultRandom(),
  provider_id:       uuid("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
  email_used:        text("email_used"),
  password_used:     text("password_used"),
  tier:              text("tier"),
  credits_remaining: real("credits_remaining"),
  created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Models ────────────────────────────────────────────────────────────────────

export const models = pgTable("models", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  provider_id:        uuid("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
  model_id:           text("model_id").notNull(),
  model_name:         text("model_name").notNull(),
  fingerprint_job_id: text("fingerprint_job_id"),
  fingerprint_hash:   text("fingerprint_hash"),
  verdict:            text("verdict"),
  fingerprinted_at:   timestamp("fingerprinted_at", { withTimezone: true }),
});

// ── Fingerprints ──────────────────────────────────────────────────────────────

export const fingerprints = pgTable("fingerprints", {
  id:               uuid("id").primaryKey().defaultRandom(),
  job_id:           text("job_id").notNull().unique(),
  workflow_run_id:  text("workflow_run_id"),
  model_name:       text("model_name"),
  model_type:       text("model_type").notNull(),
  // ── SHA-256 exact-match fast path ─────────────────────────────────────────
  fingerprint_hash: text("fingerprint_hash"),
  // ── Embedding-based similarity (v1.1) ─────────────────────────────────────
  embedding_vectors: jsonb("embedding_vectors"),      // number[][] — 15 × 1024 floats
  mean_vector:       jsonb("mean_vector"),             // number[]  — 1024 floats (pre-filter)
  similarity_score:  real("similarity_score"),         // [0,1] cosine vs best known model
  matched_model:     text("matched_model"),            // name of best-matched known model
  // ─────────────────────────────────────────────────────────────────────────
  fingerprint_data: jsonb("fingerprint_data"),
  step_events:      jsonb("step_events").default("[]"),
  status:           text("status").notNull().default("pending"),
  verdict:          text("verdict"),                   // exact_match|clone_suspect|high_similarity|same_family|unknown
  source:           text("source").notNull().default("on_demand"),
  provider_id:      uuid("provider_id").references(() => providers.id),
  created_at:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completed_at:     timestamp("completed_at", { withTimezone: true }),
});

// ── Fingerprint similarities ──────────────────────────────────────────────────
// Pairwise cosine similarity between every two fingerprints.
// Populated whenever a new fingerprint is added (compare against all existing).
// Both (a→b) and (b→a) rows are written so queries only need WHERE fp_a = $id.

export const fingerprint_similarities = pgTable("fingerprint_similarities", {
  id:              uuid("id").primaryKey().defaultRandom(),
  fp_a:            text("fp_a").notNull(),   // job_id of fingerprint A
  fp_b:            text("fp_b").notNull(),   // job_id of fingerprint B
  score:           real("score").notNull(),  // cosine similarity [0,1]
  verdict:         text("verdict"),          // clone_suspect|high_similarity|same_family|unknown
  created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Known models ──────────────────────────────────────────────────────────────

export const known_models = pgTable("known_models", {
  id:               uuid("id").primaryKey().defaultRandom(),
  name:             text("name").notNull().unique(),
  source:           text("source").notNull(),
  fingerprint_hash: text("fingerprint_hash"),
  fingerprint_data: jsonb("fingerprint_data"),
  // ── Embedding-based similarity (v1.1) ─────────────────────────────────────
  embedding_vectors: jsonb("embedding_vectors"),       // number[][] — 15 × 1024 floats
  mean_vector:       jsonb("mean_vector"),              // number[]  — 1024 floats
  // ─────────────────────────────────────────────────────────────────────────
  notes:            text("notes"),
});
