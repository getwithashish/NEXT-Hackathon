"""
crawler/db/schema.py — SQLite schema for the autonomous model crawler.

Tables:
  providers    — discovered LLM API providers
  accounts     — credentials obtained per provider
  payments     — Stripe virtual card payments per provider
  models       — individual models per provider (queued for fingerprinting)
"""
import sqlite3
import os
from pathlib import Path

DB_PATH = Path(__file__).parent / "crawler.db"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_conn()
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS providers (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        url             TEXT NOT NULL UNIQUE,
        docs_url        TEXT,
        pricing_url     TEXT,
        signup_url      TEXT,
        has_free_tier   INTEGER DEFAULT 0,   -- 1=yes, 0=no/unknown
        requires_payment INTEGER DEFAULT 0,  -- 1=yes
        requires_phone  INTEGER DEFAULT 0,   -- 1=yes — skip for now
        status          TEXT DEFAULT 'discovered',
        -- discovered | registering | registered | paying | paid
        -- fingerprinting | done | failed | skipped | manual_review
        notes           TEXT,
        discovered_at   TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id     INTEGER REFERENCES providers(id),
        email_used      TEXT,
        api_key         TEXT,
        api_base_url    TEXT,
        tier            TEXT,           -- free | paid
        credits_usd     REAL DEFAULT 0,
        created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id     INTEGER REFERENCES providers(id),
        stripe_card_id  TEXT,
        amount_usd      REAL,
        status          TEXT DEFAULT 'pending',  -- pending | charged | failed
        paid_at         TEXT
    );

    CREATE TABLE IF NOT EXISTS models (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id     INTEGER REFERENCES providers(id),
        model_id        TEXT NOT NULL,           -- provider's model identifier
        model_name      TEXT,
        status          TEXT DEFAULT 'queued',
        -- queued | fingerprinting | done | error | skipped
        fingerprint_job_id  TEXT,               -- job_id from fingerprint backend
        fingerprint_hash    TEXT,
        verdict             TEXT,
        error           TEXT,
        queued_at       TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now')),
        UNIQUE(provider_id, model_id)
    );

    CREATE INDEX IF NOT EXISTS idx_providers_status ON providers(status);
    CREATE INDEX IF NOT EXISTS idx_models_status ON models(status);
    """)
    conn.commit()
    conn.close()
    print(f"DB initialised at {DB_PATH}")


if __name__ == "__main__":
    init_db()
