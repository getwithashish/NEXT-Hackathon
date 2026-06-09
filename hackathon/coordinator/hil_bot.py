"""
hil_bot.py — Human-in-the-loop Telegram bot for payment + API-key collection.

Flow:
  1. Coordinator flags a provider as needs_payment → calls notify_pending()
  2. Bot sends a Telegram message with [✅ Paid] [⏭ Skip] buttons
  3. Human taps ✅ Paid → buttons replaced with "Please send your API key"
  4. Human types/pastes the API key as a plain message
  5. Bot saves the key to the Account table, marks provider as paid
  6. Coordinator picks it up on the next cycle and fingerprints

Usage:
    python3 hil_bot.py            # start the listener (long-poll)
    python3 hil_bot.py --notify   # send notifications for needs_payment providers (called by coordinator)
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv
from sqlalchemy import select

# Load coordinator .env first, then Hermes .env for bot token
load_dotenv(Path(__file__).parent / ".env")
load_dotenv(Path.home() / ".hermes" / ".env")

sys.path.insert(0, str(Path(__file__).parent))
from database import get_session, Provider, Account, init_db  # noqa: E402
import uuid

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
CHAT_ID = os.environ.get("TELEGRAM_HOME_CHANNEL", "5433619269")
API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}"

if not BOT_TOKEN:
    logger.error("TELEGRAM_BOT_TOKEN not set — exiting")
    sys.exit(1)

# ---------------------------------------------------------------------------
# In-memory state: tracks which provider we are waiting an API key for.
# Maps str(chat_id) → {"provider_id": str, "message_id": int, "provider_name": str}
# Only one pending entry per chat is supported (sufficient for single-user bot).
# ---------------------------------------------------------------------------
_waiting_for_key: dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Telegram helpers
# ---------------------------------------------------------------------------

def tg_post(method: str, payload: dict) -> dict:
    r = requests.post(f"{API_BASE}/{method}", json=payload, timeout=10)
    r.raise_for_status()
    return r.json()


def tg_send(text: str, parse_mode: str = "HTML",
            reply_markup: Optional[dict] = None,
            disable_preview: bool = True) -> dict:
    """Send a message to the configured home chat."""
    payload: dict = {
        "chat_id": CHAT_ID,
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": disable_preview,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return tg_post("sendMessage", payload)


def tg_edit(chat_id: int, message_id: int, text: str,
            parse_mode: str = "HTML") -> None:
    """Edit an existing message, removing its inline keyboard."""
    tg_post("editMessageText", {
        "chat_id": chat_id,
        "message_id": message_id,
        "text": text,
        "parse_mode": parse_mode,
    })


# ---------------------------------------------------------------------------
# Notification sender
# ---------------------------------------------------------------------------

def send_payment_notification(provider: Provider) -> None:
    """Send payment prompt for a single provider."""
    name       = provider.name
    base_url   = provider.base_url   or "unknown"
    pricing_url = provider.pricing_url or base_url
    docs_url   = provider.docs_url   or base_url
    notes      = provider.notes      or ""

    text = (
        f"💳 <b>Payment required — {name}</b>\n\n"
        f"This provider needs an account + credits before fingerprinting can run.\n\n"
        f"<b>Base URL:</b> <code>{base_url}</code>\n"
        f"<b>Pricing:</b> {pricing_url}\n"
        f"<b>Docs:</b> {docs_url}\n"
    )
    if notes and notes not in ("", "ok", "needs_human_payment"):
        text += f"<b>Notes:</b> <i>{notes}</i>\n"

    text += (
        "\n<b>Steps:</b>\n"
        "1. Open the pricing link above\n"
        "2. Sign in / register with <code>nextman@openpic.in</code>\n"
        "3. Add credits (up to $5)\n"
        "4. Generate an API key on their dashboard\n"
        "5. Tap <b>✅ Paid</b> — I'll ask you for the key next\n\n"
        "<i>Tap ⏭ Skip to skip this provider entirely.</i>"
    )

    keyboard = {
        "inline_keyboard": [[
            {
                "text": "✅ Paid — enter API key",
                "callback_data": json.dumps({"a": "paid", "id": provider.id}),
            },
            {
                "text": "⏭ Skip",
                "callback_data": json.dumps({"a": "skip", "id": provider.id}),
            },
        ]]
    }

    tg_send(text, reply_markup=keyboard)
    logger.info("Sent payment notification for %r", name)


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
# Callback handler (button taps)
# ---------------------------------------------------------------------------

def handle_callback(update: dict) -> None:
    """Handle inline button presses."""
    cq = update.get("callback_query", {})
    if not cq:
        return

    callback_id = cq["id"]
    chat_id     = cq["message"]["chat"]["id"]
    message_id  = cq["message"]["message_id"]

    try:
        data = json.loads(cq.get("data", "{}"))
    except json.JSONDecodeError:
        return

    action      = data.get("a")
    provider_id = data.get("id")

    if not action or not provider_id:
        return

    # Fetch provider name for display
    with get_session() as session:
        provider = session.get(Provider, provider_id)
        if not provider:
            tg_post("answerCallbackQuery", {
                "callback_query_id": callback_id,
                "text": "Provider not found in DB.",
            })
            return
        provider_name = provider.name
        provider_base_url = provider.base_url or ""

    # ── Skip ──────────────────────────────────────────────────────────────
    if action == "skip":
        with get_session() as session:
            p = session.get(Provider, provider_id)
            if p:
                p.status = "skipped"
                p.notes  = "skipped_via_telegram"
        tg_post("answerCallbackQuery", {"callback_query_id": callback_id, "text": "⏭ Skipped."})
        tg_edit(chat_id, message_id, f"⏭ <b>{provider_name}</b> — skipped.")
        logger.info("Provider %r skipped via Telegram HIL", provider_name)
        return

    # ── Paid ──────────────────────────────────────────────────────────────
    if action == "paid":
        # Enter "waiting for API key" state
        _waiting_for_key[str(chat_id)] = {
            "provider_id":   provider_id,
            "provider_name": provider_name,
            "base_url":      provider_base_url,
            "message_id":    message_id,
        }

        tg_post("answerCallbackQuery", {
            "callback_query_id": callback_id,
            "text": "Great! Now send me the API key.",
        })

        # Edit the original notification message
        tg_edit(
            chat_id, message_id,
            f"✅ <b>{provider_name}</b> — payment confirmed.\n\n"
            f"⌨️ Please reply with the <b>API key</b> you generated for this provider.\n"
            f"<i>Just paste it as a plain message.</i>",
        )
        logger.info(
            "Provider %r waiting for API key from user (chat %s)", provider_name, chat_id
        )
        return

    tg_post("answerCallbackQuery", {"callback_query_id": callback_id, "text": "Unknown action."})


# ---------------------------------------------------------------------------
# Message handler (API key collection)
# ---------------------------------------------------------------------------

def handle_message(update: dict) -> None:
    """Handle plain text messages — used for API key collection."""
    msg = update.get("message", {})
    if not msg:
        return

    chat_id = msg.get("chat", {}).get("id")
    text    = (msg.get("text") or "").strip()

    if not text or not chat_id:
        return

    state = _waiting_for_key.get(str(chat_id))
    if not state:
        # Not waiting for anything — ignore (Hermes handles normal messages)
        return

    api_key       = text
    provider_id   = state["provider_id"]
    provider_name = state["provider_name"]
    base_url      = state["base_url"]

    # Basic sanity — reject obviously wrong input
    if len(api_key) < 8 or " " in api_key:
        tg_send(
            f"⚠️ That doesn't look like an API key (too short or contains spaces).\n"
            f"Please paste the key for <b>{provider_name}</b> again.",
        )
        return

    # Save to DB: update Account (create if missing), mark provider paid
    try:
        with get_session() as session:
            provider = session.get(Provider, provider_id)
            if not provider:
                tg_send(f"❌ Provider <b>{provider_name}</b> not found in DB.")
                _waiting_for_key.pop(str(chat_id), None)
                return

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
                    email       = "nextman@openpic.in",
                    api_key     = api_key,
                )
                session.add(account)

            provider.status     = "paid"
            provider.notes      = "manually_paid_via_telegram"
            provider.updated_at = _now_utc()

        logger.info(
            "Provider %r marked paid, API key saved (len=%d)", provider_name, len(api_key)
        )
    except Exception as exc:
        logger.error("DB error saving API key for %r: %s", provider_name, exc, exc_info=True)
        tg_send(f"❌ DB error saving key for <b>{provider_name}</b>: {exc}")
        return
    finally:
        _waiting_for_key.pop(str(chat_id), None)

    # Confirm to user
    masked = api_key[:6] + "…" + api_key[-4:] if len(api_key) > 10 else "****"
    tg_send(
        f"🔑 API key saved for <b>{provider_name}</b>: <code>{masked}</code>\n\n"
        f"✅ Provider is now marked as <b>paid</b>.\n"
        f"The coordinator will fingerprint its models on the next cycle (every 2h).\n\n"
        f"<i>The backend will auto-detect the request/response format for this provider "
        f"using its documentation search agent — no manual template needed.</i>"
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _now_utc():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Long-poll listener
# ---------------------------------------------------------------------------

def run_listener() -> None:
    """Long-poll Telegram for both callback_query and message updates."""
    init_db()
    logger.info("HIL bot listener started — waiting for button presses and messages...")
    offset = 0

    while True:
        try:
            resp = requests.get(
                f"{API_BASE}/getUpdates",
                params={
                    "offset":          offset,
                    "timeout":         30,
                    "allowed_updates": ["callback_query", "message"],
                },
                timeout=40,
            )
            resp.raise_for_status()
            updates = resp.json().get("result", [])

            for update in updates:
                offset = update["update_id"] + 1
                try:
                    if "callback_query" in update:
                        handle_callback(update)
                    elif "message" in update:
                        handle_message(update)
                except Exception as e:
                    logger.error(
                        "Error handling update %d: %s", update.get("update_id"), e,
                        exc_info=True,
                    )

        except requests.exceptions.Timeout:
            continue
        except Exception as e:
            logger.error("Polling error: %s — retrying in 5s", e)
            time.sleep(5)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if "--notify" in sys.argv:
        n = notify_pending()
        print(f"Sent {n} notification(s)")
    else:
        run_listener()
