"""
hil_bot.py — Human-in-the-loop payment notifications (SEND-ONLY).

This module only sends Telegram messages via the HTTP API.
It does NOT run a listener — Hermes is the Telegram bot and receives all replies.

State is persisted in .hil_state.json so Hermes knows which providers are
waiting for an API key across sessions.

Flow:
  1. Coordinator flags provider as needs_payment → calls notify_pending()
  2. Bot sends a Telegram notification with provider details
  3. State file records the pending provider
  4. Human pays on the provider's dashboard, gets an API key
  5. Human sends the API key to Hermes (this chat)
  6. Hermes calls save_api_key(provider_id, api_key) → marks provider paid
  7. Coordinator fingerprints on the next cycle

Commands:
    python3 hil_bot.py --notify            # send notifications for needs_payment providers
    python3 hil_bot.py --save <id> <key>   # save an API key and mark provider paid
    python3 hil_bot.py --skip <id>         # skip a provider
    python3 hil_bot.py --pending           # list providers currently waiting for a key
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv
from sqlalchemy import select

# Load coordinator .env first, then Hermes .env for bot token
load_dotenv(Path(__file__).parent / ".env")
load_dotenv(Path.home() / ".hermes" / ".env")

sys.path.insert(0, str(Path(__file__).parent))
from database import get_session, Provider, Account, init_db  # noqa: E402

logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
logger = logging.getLogger("hil_bot")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID    = os.environ.get("TELEGRAM_HOME_CHANNEL", "5433619269")
API_BASE   = f"https://api.telegram.org/bot{BOT_TOKEN}"
STATE_FILE = Path(__file__).parent / ".hil_state.json"

if not BOT_TOKEN:
    logger.error("TELEGRAM_BOT_TOKEN not set — exiting")
    sys.exit(1)


# ---------------------------------------------------------------------------
# State file — persists pending providers across Hermes sessions
# ---------------------------------------------------------------------------

def _load_state() -> dict:
    """Load HIL state from disk."""
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"pending": {}}   # {provider_id: {name, base_url, notified_at}}


def _save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2))


def add_pending(provider_id: str, name: str, base_url: str) -> None:
    """Record that this provider is waiting for a human-supplied API key."""
    state = _load_state()
    state["pending"][provider_id] = {
        "name":         name,
        "base_url":     base_url,
        "notified_at":  datetime.now(timezone.utc).isoformat(),
    }
    _save_state(state)


def remove_pending(provider_id: str) -> None:
    state = _load_state()
    state["pending"].pop(provider_id, None)
    _save_state(state)


def get_pending() -> dict:
    """Return {provider_id: {name, base_url, notified_at}} for all pending providers."""
    return _load_state().get("pending", {})


# ---------------------------------------------------------------------------
# Telegram send helpers (no listener — send only)
# ---------------------------------------------------------------------------

def tg_send(text: str, parse_mode: str = "HTML", disable_preview: bool = True) -> dict:
    """Send a message to the configured home chat."""
    r = requests.post(f"{API_BASE}/sendMessage", json={
        "chat_id":                  CHAT_ID,
        "text":                     text,
        "parse_mode":               parse_mode,
        "disable_web_page_preview": disable_preview,
    }, timeout=10)
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------------------
# Notification sender
# ---------------------------------------------------------------------------

def send_payment_notification(provider: Provider) -> None:
    """Send a payment-required notification for one provider."""
    name        = provider.name
    base_url    = provider.base_url    or "unknown"
    pricing_url = provider.pricing_url or base_url
    docs_url    = provider.docs_url    or base_url
    notes       = provider.notes       or ""

    text = (
        f"💳 <b>Payment required — {name}</b>\n\n"
        f"This provider needs credits before fingerprinting can run.\n\n"
        f"<b>Base URL:</b> <code>{base_url}</code>\n"
        f"<b>Pricing:</b> {pricing_url}\n"
        f"<b>Docs:</b>    {docs_url}\n"
    )
    if notes and notes not in ("", "ok", "needs_human_payment"):
        text += f"<b>Notes:</b> <i>{notes}</i>\n"

    text += (
        f"\n<b>Steps:</b>\n"
        f"1. Open the pricing page above\n"
        f"2. Sign in / register with <code>nextman@openpic.in</code>\n"
        f"3. Add credits (up to $5)\n"
        f"4. Generate an API key on their dashboard\n\n"
        f"Then <b>reply here with just the API key</b> and I'll handle the rest.\n"
        f"<i>To skip, reply: <code>skip {name}</code></i>\n\n"
        f"<b>Provider ID:</b> <code>{provider.id}</code>"
    )

    tg_send(text)
    add_pending(provider.id, name, base_url)
    logger.info("Sent payment notification for %r (id=%s)", name, provider.id)


def notify_pending() -> int:
    """Send notifications for all needs_payment providers. Returns count sent."""
    init_db()
    sent = 0
    with get_session() as session:
        providers = session.scalars(
            select(Provider).where(Provider.status == "needs_payment")
        ).all()
        for p in providers:
            try:
                send_payment_notification(p)
                sent += 1
                time.sleep(0.5)
            except Exception as e:
                logger.error("Failed to notify for %r: %s", p.name, e)
    return sent


# ---------------------------------------------------------------------------
# API key saver — called by Hermes when the human sends the key
# ---------------------------------------------------------------------------

def save_api_key(provider_id: str, api_key: str) -> dict:
    """
    Save an API key to the Account table and mark the provider as paid.
    Returns {"ok": True, "name": ...} or {"ok": False, "error": ...}.
    """
    init_db()
    try:
        with get_session() as session:
            provider = session.get(Provider, provider_id)
            if not provider:
                return {"ok": False, "error": f"Provider {provider_id!r} not found"}

            name = provider.name

            # Upsert Account row
            account = session.scalar(
                select(Account).where(Account.provider_id == provider_id)
            )
            if account:
                account.api_key = api_key
            else:
                account = Account(
                    id          = str(uuid.uuid4()),
                    provider_id = provider_id,
                    email_used  = "nextman@openpic.in",
                    api_key     = api_key,
                )
                session.add(account)

            provider.status     = "paid"
            provider.notes      = "manually_paid_via_telegram"
            provider.updated_at = datetime.now(timezone.utc)

        remove_pending(provider_id)
        logger.info("API key saved for %r (len=%d), status → paid", name, len(api_key))

        # Confirm back to Telegram
        masked = api_key[:6] + "…" + api_key[-4:] if len(api_key) > 10 else "****"
        tg_send(
            f"🔑 API key saved for <b>{name}</b>: <code>{masked}</code>\n\n"
            f"✅ Provider marked as <b>paid</b>. "
            f"The coordinator will fingerprint its models on the next cycle.\n\n"
            f"<i>The backend auto-detects the request/response format for this "
            f"provider using its documentation search agent — no manual setup needed.</i>"
        )
        return {"ok": True, "name": name}

    except Exception as exc:
        logger.error("Failed to save API key for %r: %s", provider_id, exc, exc_info=True)
        return {"ok": False, "error": str(exc)}


def skip_provider(provider_id: str) -> dict:
    """Mark a provider as skipped."""
    init_db()
    try:
        with get_session() as session:
            provider = session.get(Provider, provider_id)
            if not provider:
                return {"ok": False, "error": f"Provider {provider_id!r} not found"}
            name = provider.name
            provider.status = "skipped"
            provider.notes  = "skipped_via_telegram"
        remove_pending(provider_id)
        logger.info("Provider %r skipped", name)
        tg_send(f"⏭ <b>{name}</b> skipped.")
        return {"ok": True, "name": name}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# CLI entry point (for debugging / manual use)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    args = sys.argv[1:]

    if not args or args[0] == "--notify":
        n = notify_pending()
        print(f"Sent {n} notification(s)")

    elif args[0] == "--pending":
        pending = get_pending()
        if not pending:
            print("No providers waiting for API keys")
        else:
            print(f"{len(pending)} provider(s) waiting:")
            for pid, info in pending.items():
                print(f"  {info['name']:30} id={pid}")

    elif args[0] == "--save" and len(args) == 3:
        result = save_api_key(args[1], args[2])
        print(result)

    elif args[0] == "--skip" and len(args) == 2:
        result = skip_provider(args[1])
        print(result)

    else:
        print(__doc__)
        sys.exit(1)
