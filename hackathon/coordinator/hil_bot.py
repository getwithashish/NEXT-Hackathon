"""
hil_bot.py — Human-in-the-loop Telegram bot for payment notifications.

Sends a Telegram message with inline buttons when a provider needs payment.
Runs as a long-poll listener that handles button callbacks and updates the DB.

Usage:
    python3 hil_bot.py            # start the listener (handles button presses)
    python3 hil_bot.py --notify   # send pending notifications (called by coordinator)
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from sqlalchemy import select

# Load coordinator .env first, then Hermes .env for bot token
load_dotenv(Path(__file__).parent / ".env")
load_dotenv(Path.home() / ".hermes" / ".env")

sys.path.insert(0, str(Path(__file__).parent))
from database import get_session, Provider, init_db  # noqa: E402

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
# Telegram helpers
# ---------------------------------------------------------------------------

def tg_post(method: str, payload: dict) -> dict:
    r = requests.post(f"{API_BASE}/{method}", json=payload, timeout=10)
    r.raise_for_status()
    return r.json()


def send_payment_notification(provider: Provider) -> None:
    """Send a Telegram message with Pay / Skip inline buttons for a provider."""
    name = provider.name
    base_url = provider.base_url or "unknown"
    pricing_url = provider.pricing_url or base_url
    docs_url = provider.docs_url or base_url
    notes = provider.notes or ""

    text = (
        f"💳 <b>Payment required — {name}</b>\n\n"
        f"This provider needs credits before fingerprinting can run.\n\n"
        f"<b>Base URL:</b> <code>{base_url}</code>\n"
        f"<b>Pricing:</b> {pricing_url}\n"
        f"<b>Docs:</b> {docs_url}\n"
    )
    if notes and notes not in ("", "ok", "needs_human_payment"):
        text += f"<b>Notes:</b> <i>{notes}</i>\n"

    text += (
        "\n<b>What to do:</b>\n"
        "1. Open the pricing link above\n"
        "2. Sign in with <code>nextman@openpic.in</code>\n"
        "3. Add credits (up to $5)\n"
        "4. Tap <b>✅ Paid</b> below — coordinator fingerprints on next run\n\n"
        "<i>Tap ⏭ Skip to skip this provider entirely.</i>"
    )

    keyboard = {
        "inline_keyboard": [
            [
                {
                    "text": "✅ Paid — proceed to fingerprint",
                    "callback_data": json.dumps({"a": "paid", "id": provider.id}),
                },
                {
                    "text": "⏭ Skip this provider",
                    "callback_data": json.dumps({"a": "skip", "id": provider.id}),
                },
            ]
        ]
    }

    tg_post("sendMessage", {
        "chat_id": CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "reply_markup": keyboard,
        "disable_web_page_preview": True,
    })
    logger.info("Sent payment notification for %r", name)


def notify_pending() -> int:
    """Send notifications for all providers with status='needs_payment'. Returns count sent."""
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
# Callback handler
# ---------------------------------------------------------------------------

def handle_callback(update: dict) -> None:
    """Handle inline button press from Telegram."""
    cq = update.get("callback_query", {})
    if not cq:
        return

    callback_id = cq["id"]
    chat_id = cq["message"]["chat"]["id"]
    message_id = cq["message"]["message_id"]

    try:
        data = json.loads(cq.get("data", "{}"))
    except json.JSONDecodeError:
        return

    action = data.get("a")
    provider_id = data.get("id")

    if not action or not provider_id:
        return

    with get_session() as session:
        provider = session.get(Provider, provider_id)
        if not provider:
            tg_post("answerCallbackQuery", {
                "callback_query_id": callback_id,
                "text": "Provider not found in DB.",
            })
            return

        provider_name = provider.name

        if action == "paid":
            provider.status = "paid"
            provider.notes = "manually_paid_via_telegram"
            answer_text = "✅ Marked as paid!"
            edit_text = (
                f"✅ <b>{provider_name}</b> — marked as paid.\n"
                f"Will be fingerprinted in the next coordinator cycle (runs every 2h)."
            )
            logger.info("Provider %r marked as paid via Telegram HIL", provider_name)

        elif action == "skip":
            provider.status = "skipped"
            provider.notes = "skipped_via_telegram"
            answer_text = "⏭ Skipped."
            edit_text = f"⏭ <b>{provider_name}</b> — skipped."
            logger.info("Provider %r skipped via Telegram HIL", provider_name)

        else:
            tg_post("answerCallbackQuery", {
                "callback_query_id": callback_id,
                "text": "Unknown action.",
            })
            return

    # Acknowledge the tap (removes loading spinner)
    tg_post("answerCallbackQuery", {
        "callback_query_id": callback_id,
        "text": answer_text,
    })

    # Edit the original message — replace buttons with outcome text
    tg_post("editMessageText", {
        "chat_id": chat_id,
        "message_id": message_id,
        "text": edit_text,
        "parse_mode": "HTML",
    })


# ---------------------------------------------------------------------------
# Long-poll listener
# ---------------------------------------------------------------------------

def run_listener() -> None:
    """Long-poll Telegram for callback_query updates and handle them."""
    init_db()
    logger.info("HIL bot listener started — waiting for button presses...")
    offset = 0

    while True:
        try:
            resp = requests.get(
                f"{API_BASE}/getUpdates",
                params={
                    "offset": offset,
                    "timeout": 30,
                    "allowed_updates": ["callback_query"],
                },
                timeout=40,
            )
            resp.raise_for_status()
            updates = resp.json().get("result", [])

            for update in updates:
                offset = update["update_id"] + 1
                try:
                    handle_callback(update)
                except Exception as e:
                    logger.error("Error handling update %d: %s", update.get("update_id"), e)

        except requests.exceptions.Timeout:
            continue  # normal long-poll timeout, retry
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
