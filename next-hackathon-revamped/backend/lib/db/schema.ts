/**
 * db/schema.ts — Unified Neon Postgres schema for the revamped app.
 *
 * Key changes from v1:
 *   - Stripe/payment tables removed — user supplies API key directly via HIL
 *   - providers.api_key added — stores the key entered by user in the HIL approval UI
 *   - providers.approval_run_id added — links to the payment-approval workflow run
 *   - fingerprints.step_events added — JSONB array of real step progress events
 *   - known_models.fingerprint_data stays — reference hashes for comparison
 */

import { pgTable, text, boolean, timestamp, jsonb, real, uuid } from "drizzle-orm/pg-core";

// ── Providers ─────────────────────────────────────────────────────────────────
// Discovered by the autonomous crawler. status flow:
//   discovered → registered → needs_api_key → approved → fingerprinting → done | failed | skipped

export const providers = pgTable("providers", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  name:               text("name").notNull(),
  base_url:           text("base_url"),
  docs_url:           text("docs_url"),
  pricing_url:        text("pricing_url"),
  free_tier:          boolean("free_tier").notNull().default(false),
  requires_payment:   boolean("requires_payment").notNull().default(false),
  status:             text("status").notNull().default("discovered"),
  // ── New in revamp ──────────────────────────────────────────────────────────
  api_key:            text("api_key"),                  // entered by user in HIL UI
  approval_run_id:    text("approval_run_id"),          // workflow run waiting for HIL
  // ──────────────────────────────────────────────────────────────────────────
  notes:              text("notes"),
  discovered_at:      timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:         timestamp("updated_at",    { withTimezone: true }).notNull().defaultNow(),
});

// ── Accounts ─────────────────────────────────────────────────────────────────
// Credentials for each provider (email/password from RegistrationAgent)

export const accounts = pgTable("accounts", {
  id:            uuid("id").primaryKey().defaultRandom(),
  provider_id:   uuid("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
  email_used:    text("email_used"),
  password_used: text("password_used"),
  tier:          text("tier"),
  credits_remaining: real("credits_remaining"),
  created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Models ────────────────────────────────────────────────────────────────────
// Individual model IDs available at each provider

export const models = pgTable("models", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  provider_id:         uuid("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
  model_id:            text("model_id").notNull(),    // e.g. "gpt-4o"
  model_name:          text("model_name").notNull(),
  fingerprint_job_id:  text("fingerprint_job_id"),
  fingerprint_hash:    text("fingerprint_hash"),
  verdict:             text("verdict"),
  fingerprinted_at:    timestamp("fingerprinted_at", { withTimezone: true }),
});

// ── Fingerprints ──────────────────────────────────────────────────────────────
// One row per fingerprint job (on-demand or crawler-triggered)

export const fingerprints = pgTable("fingerprints", {
  id:               uuid("id").primaryKey().defaultRandom(),
  job_id:           text("job_id").notNull().unique(),
  workflow_run_id:  text("workflow_run_id"),            // Vercel Workflow runId
  model_name:       text("model_name"),
  model_type:       text("model_type").notNull(),       // "api"
  fingerprint_hash: text("fingerprint_hash"),
  fingerprint_data: jsonb("fingerprint_data"),           // full behavioral signature
  step_events:      jsonb("step_events").default("[]"), // ← real step progress array
  status:           text("status").notNull().default("pending"),
  source:           text("source").notNull().default("on_demand"), // "on_demand" | "crawler"
  provider_id:      uuid("provider_id").references(() => providers.id),
  created_at:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completed_at:     timestamp("completed_at", { withTimezone: true }),
});

// ── Known models ──────────────────────────────────────────────────────────────
// Reference fingerprints (seeded) for comparison

export const known_models = pgTable("known_models", {
  id:               uuid("id").primaryKey().defaultRandom(),
  name:             text("name").notNull().unique(),
  source:           text("source").notNull(),           // "anthropic", "openai", etc.
  fingerprint_hash: text("fingerprint_hash"),
  fingerprint_data: jsonb("fingerprint_data"),
  notes:            text("notes"),
});
