/**
 * POST /api/init-db
 * Creates all tables + seeds known_models if they don't exist.
 * Safe to call multiple times (uses CREATE TABLE IF NOT EXISTS).
 */

import { defineEventHandler } from "h3";
import { db, getRawSql } from "../../lib/db/index";
import { known_models } from "../../lib/db/schema";
import { count } from "drizzle-orm";

export default defineEventHandler(async () => {
  try {
    if (!process.env.DATABASE_URL) {
      return { ok: false, error: "DATABASE_URL not set" };
    }

    const sql = getRawSql();

    await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`;

    await sql`
      CREATE TABLE IF NOT EXISTS providers (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name              TEXT NOT NULL,
        base_url          TEXT,
        docs_url          TEXT,
        pricing_url       TEXT,
        free_tier         BOOLEAN NOT NULL DEFAULT false,
        requires_payment  BOOLEAN NOT NULL DEFAULT false,
        status            TEXT NOT NULL DEFAULT 'discovered',
        api_key           TEXT,
        approval_run_id   TEXT,
        notes             TEXT,
        discovered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS accounts (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_id       UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        email_used        TEXT,
        password_used     TEXT,
        tier              TEXT,
        credits_remaining REAL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS models (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_id          UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_id             TEXT NOT NULL,
        model_name           TEXT NOT NULL,
        fingerprint_job_id   TEXT,
        fingerprint_hash     TEXT,
        verdict              TEXT,
        fingerprinted_at     TIMESTAMPTZ
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS fingerprints (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id            TEXT NOT NULL UNIQUE,
        workflow_run_id   TEXT,
        model_name        TEXT,
        model_type        TEXT NOT NULL,
        fingerprint_hash  TEXT,
        fingerprint_data  JSONB,
        step_events       JSONB DEFAULT '[]',
        status            TEXT NOT NULL DEFAULT 'pending',
        source            TEXT NOT NULL DEFAULT 'on_demand',
        provider_id       UUID REFERENCES providers(id),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at      TIMESTAMPTZ
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS known_models (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name              TEXT NOT NULL UNIQUE,
        source            TEXT NOT NULL,
        fingerprint_hash  TEXT,
        fingerprint_data  JSONB,
        notes             TEXT
      )
    `;

    // Seed known_models if empty
    const [{ value: existingCount }] = await db.select({ value: count() }).from(known_models);

    let seeded = 0;
    if (existingCount === 0) {
      await sql`
        INSERT INTO known_models (name, source, notes) VALUES
          ('GPT-4o',              'openai',    'OpenAI GPT-4o reference'),
          ('GPT-4 Turbo',         'openai',    'OpenAI GPT-4 Turbo reference'),
          ('GPT-3.5 Turbo',       'openai',    'OpenAI GPT-3.5 Turbo reference'),
          ('Claude 3.5 Sonnet',   'anthropic', 'Anthropic Claude 3.5 Sonnet reference'),
          ('Claude 3 Haiku',      'anthropic', 'Anthropic Claude 3 Haiku reference'),
          ('Gemini 1.5 Pro',      'google',    'Google Gemini 1.5 Pro reference'),
          ('Gemini 1.5 Flash',    'google',    'Google Gemini 1.5 Flash reference'),
          ('Llama 3.1 70B',       'meta',      'Meta Llama 3.1 70B reference'),
          ('Mistral Large',       'mistral',   'Mistral Large reference'),
          ('Command R+',          'cohere',    'Cohere Command R+ reference')
        ON CONFLICT (name) DO NOTHING
      `;
      seeded = 10;
    }

    return {
      ok: true,
      message: "Database initialized successfully",
      tables: ["providers", "accounts", "models", "fingerprints", "known_models"],
      known_models_seeded: seeded,
    };
  } catch (err: any) {
    console.error("[init-db]", err);
    return { ok: false, error: String(err?.message ?? err) };
  }
});
