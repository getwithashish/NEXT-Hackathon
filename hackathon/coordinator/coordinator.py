"""
coordinator.py — Main state-machine coordinator.

Runs one full orchestration cycle (discovery → registration → payment →
fingerprinting → report).  Invoked directly by cron or manually.
"""

from __future__ import annotations

import logging
import os
import sys

# Load .env from coordinator directory before anything reads env vars
from pathlib import Path
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    from dotenv import load_dotenv
    load_dotenv(_env_path)
import uuid
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Logging — timestamps to stdout so cron captures them
# ---------------------------------------------------------------------------

logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("coordinator")

# ---------------------------------------------------------------------------
# Local imports
# ---------------------------------------------------------------------------

import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from agents.discovery_agent import DiscoveryAgent
from agents.registration_agent import RegistrationAgent
from agents.payment_agent import PaymentAgent
from agents.fingerprint_client import FingerprintClient
from hil_bot import notify_pending as hil_notify_pending

from database import (
    get_session,
    init_db,
    Provider,
    Account,
    Payment,
    Model,
)
from sqlalchemy import select

# ---------------------------------------------------------------------------
# Configuration from environment variables
# ---------------------------------------------------------------------------

EXA_API_KEY=os.env...EY", "")
IMAP_HOST            = os.environ.get("IMAP_HOST", "mail.openpic.in")
IMAP_USER            = os.environ.get("IMAP_USER", "nextman@openpic.in")
IMAP_PASS            = os.environ.get("IMAP_PASS", "")
REGISTRATION_EMAIL   = os.environ.get("REGISTRATION_EMAIL", "nextman@openpic.in")
REGISTRATION_PASSWORD=os.env...RD", "")
BACKEND_URL          = os.environ.get("BACKEND_URL", "http://54.86.179.209:8000")
# Vercel Nitro backend URL — hosts all Vercel Workflow triggers
VERCEL_BACKEND_URL   = os.environ.get("VERCEL_BACKEND_URL", "")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _provider_to_dict(p: Provider) -> dict:
    """Convert ORM Provider to a plain dict for agent consumption."""
    return {
        "id": p.id,
        "name": p.name,
        "base_url": p.base_url or "",
        "docs_url": p.docs_url or "",
        "pricing_url": p.pricing_url or "",
        "free_tier": p.free_tier,
        "requires_payment": p.requires_payment,
        "status": p.status,
        "notes": p.notes or "",
    }


def _account_to_dict(a: Account) -> dict:
    """Convert ORM Account to a plain dict for agent consumption."""
    return {
        "id": a.id,
        "provider_id": a.provider_id,
        "email": a.email_used or "",
        "email_used": a.email_used or "",
        "password": a.password_used or "",
        "password_used": a.password_used or "",
        "api_key": a.api_key or "",
        "tier": a.tier or "",
        "credits_remaining": a.credits_remaining,
    }


# ---------------------------------------------------------------------------
# Step 1 — Discovery
# ---------------------------------------------------------------------------

def step_discovery() -> int:
    """Discover new providers and persist them.  Returns count of new providers."""
    logger.info("=== STEP 1: Discovery ===")

    # Load existing base_urls
    with get_session() as session:
        existing_urls: set[str] = {
            row
            for row in session.scalars(select(Provider.base_url)).all()
            if row
        }

    logger.info("Existing providers in DB: %d", len(existing_urls))

    agent = DiscoveryAgent()
    try:
        new_providers = agent.run(existing_urls)
    except Exception as exc:
        logger.error("DiscoveryAgent.run() failed: %s", exc, exc_info=True)
        return 0

    logger.info("Discovery returned %d new provider(s)", len(new_providers))

    inserted = 0
    for pdata in new_providers:
        try:
            with get_session() as session:
                # Double-check uniqueness within this session
                existing = session.scalar(
                    select(Provider).where(Provider.base_url == pdata.get("base_url"))
                )
                if existing:
                    logger.debug(
                        "Provider with base_url %r already exists — skipping",
                        pdata.get("base_url"),
                    )
                    continue

                provider = Provider(
                    id=str(uuid.uuid4()),
                    name=pdata.get("name", "unknown"),
                    base_url=pdata.get("base_url"),
                    docs_url=pdata.get("docs_url"),
                    pricing_url=pdata.get("pricing_url"),
                    free_tier=bool(pdata.get("free_tier", False)),
                    requires_payment=bool(pdata.get("requires_payment", False)),
                    status="discovered",
                    notes=pdata.get("notes", ""),
                )
                session.add(provider)
                session.flush()  # get provider.id

                # Insert models
                for model_id_str in pdata.get("model_ids", []):
                    if not model_id_str:
                        continue
                    model = Model(
                        id=str(uuid.uuid4()),
                        provider_id=provider.id,
                        model_id=str(model_id_str),
                        model_name=str(model_id_str),
                    )
                    session.add(model)

                inserted += 1
                logger.info(
                    "Inserted provider %r (%s) with %d model(s)",
                    provider.name,
                    provider.base_url,
                    len(pdata.get("model_ids", [])),
                )
        except Exception as exc:
            logger.error(
                "Failed to insert provider %r: %s",
                pdata.get("name"),
                exc,
                exc_info=True,
            )

    logger.info("Discovery step complete. Inserted %d new provider(s).", inserted)
    return inserted


# ---------------------------------------------------------------------------
# Step 2 — Registration
# ---------------------------------------------------------------------------

def step_registration() -> int:
    """Register discovered providers.  Returns count of successfully registered."""
    logger.info("=== STEP 2: Registration ===")

    if not REGISTRATION_EMAIL or not REGISTRATION_PASSWORD:
        logger.warning(
            "REGISTRATION_EMAIL or REGISTRATION_PASSWORD not set — skipping registration"
        )
        return 0

    with get_session() as session:
        # Providers with status='discovered' that have no accounts yet
        providers_raw = session.scalars(
            select(Provider).where(Provider.status == "discovered")
        ).all()

        to_register: list[Provider] = []
        for p in providers_raw:
            has_account = session.scalar(
                select(Account).where(Account.provider_id == p.id)
            )
            if not has_account:
                to_register.append(p)

        providers_to_process = [_provider_to_dict(p) for p in to_register]

    logger.info("Providers to register: %d", len(providers_to_process))

    if not providers_to_process:
        return 0

    agent = RegistrationAgent(
        email=REGISTRATION_EMAIL,
        password=REGISTRATION_PASSWORD,
        imap_host=IMAP_HOST,
        imap_user=IMAP_USER,
        imap_pass=IMAP_PASS,
    )

    succeeded = 0
    for pdict in providers_to_process:
        provider_id = pdict["id"]
        provider_name = pdict["name"]
        logger.info("Registering provider: %r (%s)", provider_name, pdict["base_url"])

        try:
            result = agent.register(pdict)
        except Exception as exc:
            logger.error(
                "Unexpected error registering %r: %s", provider_name, exc, exc_info=True
            )
            result = {"success": False, "notes": f"error: {exc}", "api_key": None,
                      "email_used": REGISTRATION_EMAIL, "password_used": ""}

        try:
            with get_session() as session:
                provider = session.get(Provider, provider_id)
                if provider is None:
                    logger.error("Provider %r not found in DB — skipping update", provider_id)
                    continue

                if result.get("success"):
                    # Save account
                    account = Account(
                        id=str(uuid.uuid4()),
                        provider_id=provider_id,
                        email_used=result.get("email_used", REGISTRATION_EMAIL),
                        password_used=result.get("password_used", ""),
                        api_key=result.get("api_key"),
                        tier="free",
                    )
                    session.add(account)
                    provider.status = "registered"
                    provider.updated_at = _now_utc()
                    succeeded += 1
                    logger.info(
                        "Successfully registered %r — api_key=%r",
                        provider_name,
                        (result.get("api_key") or "")[:12] + "…" if result.get("api_key") else None,
                    )
                else:
                    notes = result.get("notes", "unknown_failure")
                    provider.status = "skipped"
                    provider.notes = notes
                    provider.updated_at = _now_utc()
                    logger.warning(
                        "Skipping %r — reason: %s", provider_name, notes
                    )
        except Exception as exc:
            logger.error(
                "DB update failed for %r: %s", provider_name, exc, exc_info=True
            )

    logger.info("Registration step complete. Succeeded: %d", succeeded)
    return succeeded


# ---------------------------------------------------------------------------
# Step 3 — Payment
# ---------------------------------------------------------------------------

def step_payment() -> int:
    """
    For providers that require payment (= need an API key from the user):
    trigger the Vercel payment-approval workflow which pauses for HIL.
    The user enters the API key in the web UI — no Telegram needed.
    Returns count of providers queued for HIL.
    """
    logger.info("=== STEP 3: Payment / API-key HIL ===")

    if not VERCEL_BACKEND_URL:
        logger.warning(
            "VERCEL_BACKEND_URL not set — skipping HIL trigger for payment-required providers"
        )
        return 0

    with get_session() as session:
        providers_raw = session.scalars(
            select(Provider).where(
                Provider.status == "registered",
                Provider.requires_payment == True,
            )
        ).all()

        to_queue: list[tuple[dict, dict | None]] = []
        for p in providers_raw:
            account_orm = session.scalar(
                select(Account).where(Account.provider_id == p.id)
            )
            account_dict = _account_to_dict(account_orm) if account_orm else None
            to_queue.append((_provider_to_dict(p), account_dict))

    logger.info("Providers requiring API-key approval: %d", len(to_queue))

    queued = 0
    for pdict, account_dict in to_queue:
        provider_id = pdict["id"]
        provider_name = pdict["name"]

        logger.info(
            "Provider %r requires API key — triggering Vercel HIL workflow", provider_name
        )
        try:
            import requests as _req
            resp = _req.post(
                f"{VERCEL_BACKEND_URL}/api/approval/start",
                json={
                    "provider_id":   provider_id,
                    "provider_name": provider_name,
                    "docs_url":      pdict.get("docs_url"),
                    "pricing_url":   pdict.get("pricing_url"),
                    "model_ids":     [],   # models added after registration
                },
                timeout=15,
            )
            resp.raise_for_status()
            run_id = resp.json().get("run_id", "")
            logger.info(
                "HIL workflow started for %r — run_id=%r", provider_name, run_id
            )
            with get_session() as session:
                provider = session.get(Provider, provider_id)
                if provider and provider.status == "registered":
                    provider.status = "needs_payment"
                    provider.notes = f"hil_workflow:{run_id}"
                    provider.updated_at = _now_utc()
            queued += 1
        except Exception as exc:
            logger.error(
                "Failed to trigger HIL workflow for %r: %s", provider_name, exc, exc_info=True
            )

    logger.info("Payment/HIL step complete. Queued for web approval: %d", queued)
    return queued


# ---------------------------------------------------------------------------
# Step 4 — Fingerprinting
# ---------------------------------------------------------------------------

def step_fingerprinting() -> int:
    """
    Submit fingerprint jobs for eligible providers/models.

    Routing:
      - VERCEL_BACKEND_URL set → free-tier providers (status="registered",
        requires_payment=False) are submitted to the Vercel crawl-fingerprint
        workflow via POST /api/fingerprint/crawl-start.  The workflow runs
        the job and stores results in Neon Postgres.  We poll the workflow
        status endpoint to track completion and update our local SQLite.

      - providers that went through HIL (status="approved" in Vercel DB) have
        already been submitted by the payment-approval workflow's step 4.
        The coordinator just marks them done when their Vercel run completes.

      - Fallback (no VERCEL_BACKEND_URL): submit directly to the old FastAPI
        backend and poll as before.  This keeps the old pipeline working
        during the transition period.
    """
    logger.info("=== STEP 4: Fingerprinting ===")

    fp_client = FingerprintClient(backend_url=BACKEND_URL)

    # Load free-tier providers in 'registered' state (requires_payment=False)
    with get_session() as session:
        providers_raw = session.scalars(
            select(Provider).where(
                Provider.status.in_(["registered", "paid"]),
            )
        ).all()
        eligible: list[tuple[dict, dict | None, list[dict]]] = []
        for p in providers_raw:
            account_orm = session.scalar(
                select(Account).where(Account.provider_id == p.id)
            )
            account_dict = _account_to_dict(account_orm) if account_orm else None

            models_raw = session.scalars(
                select(Model).where(
                    Model.provider_id == p.id,
                    Model.fingerprint_hash == None,
                )
            ).all()
            models_list = [
                {
                    "id": m.id,
                    "model_id": m.model_id,
                    "model_name": m.model_name,
                    "fingerprint_job_id": m.fingerprint_job_id,
                }
                for m in models_raw
            ]
            if models_list:
                eligible.append((_provider_to_dict(p), account_dict, models_list))

    logger.info(
        "Providers with un-fingerprinted models: %d", len(eligible)
    )

    models_done_total = 0

    for pdict, account_dict, models in eligible:
        provider_id = pdict["id"]
        provider_name = pdict["name"]
        api_key = (account_dict or {}).get("api_key", "")
        api_endpoint = pdict.get("base_url", "")
        docs_url = pdict.get("docs_url")

        logger.info(
            "Fingerprinting %d model(s) for provider %r",
            len(models),
            provider_name,
        )

        # ── Path A: Vercel crawl-fingerprint workflow ─────────────────────────
        if VERCEL_BACKEND_URL:
            model_ids = [m["model_id"] for m in models]
            try:
                import requests as _req
                resp = _req.post(
                    f"{VERCEL_BACKEND_URL}/api/fingerprint/crawl-start",
                    json={
                        "provider_id":   provider_id,
                        "provider_name": provider_name,
                        "api_key":       api_key,
                        "docs_url":      docs_url,
                        "model_ids":     model_ids,
                    },
                    timeout=20,
                )
                resp.raise_for_status()
                data = resp.json()
                run_ids = data.get("run_ids", [])
                logger.info(
                    "Submitted %d crawl-fingerprint workflow(s) for %r — run_ids=%r",
                    len(run_ids), provider_name, run_ids,
                )

                # Poll each Vercel workflow run until done
                import time as _time
                for i, (mdata, run_id) in enumerate(zip(models, run_ids)):
                    model_db_id = mdata["id"]
                    model_id    = mdata["model_id"]
                    deadline = _time.monotonic() + 600  # 10-minute timeout per model

                    while _time.monotonic() < deadline:
                        try:
                            status_resp = _req.get(
                                f"{VERCEL_BACKEND_URL}/api/fingerprint/status/{run_id}",
                                timeout=10,
                            )
                            status_resp.raise_for_status()
                            run_data = status_resp.json()
                            run_status = run_data.get("status", "")

                            if run_status == "completed":
                                result = run_data.get("result") or {}
                                fingerprint_hash = result.get("behavior_hash")
                                verdict = result.get("verdict")
                                with get_session() as session:
                                    model_orm = session.get(Model, model_db_id)
                                    if model_orm:
                                        model_orm.fingerprint_hash = fingerprint_hash or "done"
                                        model_orm.verdict = verdict
                                        model_orm.fingerprinted_at = _now_utc()
                                models_done_total += 1
                                logger.info(
                                    "Vercel workflow complete for %r/%r — verdict=%r",
                                    provider_name, model_id, verdict,
                                )
                                break

                            elif run_status == "failed":
                                logger.warning(
                                    "Vercel workflow %r failed for %r/%r",
                                    run_id, provider_name, model_id,
                                )
                                break

                        except Exception as poll_exc:
                            logger.warning(
                                "Poll error for run %r (%r/%r): %s",
                                run_id, provider_name, model_id, poll_exc,
                            )

                        _time.sleep(15)
                    else:
                        logger.warning(
                            "Vercel workflow %r timed out for %r/%r",
                            run_id, provider_name, model_id,
                        )

            except Exception as exc:
                logger.error(
                    "Failed to submit Vercel crawl-fingerprint for %r: %s",
                    provider_name, exc, exc_info=True,
                )
            # Skip the old polling loop for this provider
            continue

        # ── Path B: legacy direct FastAPI backend (no VERCEL_BACKEND_URL) ────
        models_done_this_provider = 0

        for mdata in models:
            model_db_id = mdata["id"]
            model_id = mdata["model_id"]
            model_name = mdata["model_name"]
            job_id = mdata.get("fingerprint_job_id")

            if not job_id:
                try:
                    job_id = fp_client.submit_job(
                        provider_name=provider_name,
                        api_endpoint=api_endpoint,
                        api_key=api_key,
                        model_name=model_name,
                        model_hint=model_id,
                    )
                    logger.info(
                        "Submitted fingerprint job for %r/%r — job_id=%r",
                        provider_name, model_name, job_id,
                    )
                    with get_session() as session:
                        model_orm = session.get(Model, model_db_id)
                        if model_orm:
                            model_orm.fingerprint_job_id = job_id
                except Exception as exc:
                    logger.error(
                        "Failed to submit fingerprint job for %r/%r: %s",
                        provider_name, model_name, exc, exc_info=True,
                    )
                    continue

            try:
                logger.info(
                    "Polling fingerprint job %r for %r/%r",
                    job_id, provider_name, model_name,
                )
                job_result = fp_client.poll_job(job_id, timeout_seconds=300, poll_interval=10)
                status = job_result.get("status", "")

                if status == "done":
                    result_payload = job_result.get("result") or job_result
                    fingerprint_hash = (
                        result_payload.get("fingerprint_hash")
                        or result_payload.get("hash")
                        or result_payload.get("fp_hash")
                    )
                    verdict = (
                        result_payload.get("verdict")
                        or result_payload.get("matched_model")
                        or result_payload.get("label")
                    )
                    with get_session() as session:
                        model_orm = session.get(Model, model_db_id)
                        if model_orm:
                            model_orm.fingerprint_hash = fingerprint_hash or "done"
                            model_orm.verdict = verdict
                            model_orm.fingerprinted_at = _now_utc()
                    models_done_this_provider += 1
                    models_done_total += 1
                    logger.info(
                        "Fingerprint complete for %r/%r — verdict=%r",
                        provider_name, model_name, verdict,
                    )
                else:
                    logger.warning(
                        "Fingerprint job %r ended with status=%r for %r/%r",
                        job_id, status, provider_name, model_name,
                    )
            except TimeoutError:
                logger.warning(
                    "Fingerprint job %r timed out for %r/%r",
                    job_id, provider_name, model_name,
                )
            except Exception as exc:
                logger.error(
                    "Polling error for job %r (%r/%r): %s",
                    job_id, provider_name, model_name, exc, exc_info=True,
                )

        # If ALL models for this provider are now fingerprinted, mark provider done
        try:
            with get_session() as session:
                remaining = session.scalar(
                    select(Model).where(
                        Model.provider_id == provider_id,
                        Model.fingerprint_hash == None,
                    )
                )
                if remaining is None:
                    provider_orm = session.get(Provider, provider_id)
                    if provider_orm and provider_orm.status in ("registered", "paid"):
                        provider_orm.status = "done"
                        provider_orm.updated_at = _now_utc()
                        logger.info(
                            "All models fingerprinted for %r — status → done",
                            provider_name,
                        )
        except Exception as exc:
            logger.error(
                "Failed to check/update done status for %r: %s",
                provider_name,
                exc,
                exc_info=True,
            )

    logger.info("Fingerprinting step complete. Models fingerprinted: %d", models_done_total)
    return models_done_total


# ---------------------------------------------------------------------------
# Step 5 — Report
# ---------------------------------------------------------------------------

def step_report() -> None:
    """Print a summary of the current pipeline state."""
    logger.info("=== STEP 5: Report ===")

    with get_session() as session:
        all_providers = session.scalars(select(Provider)).all()
        total_providers = len(all_providers)

        status_counts: dict[str, int] = {}
        for p in all_providers:
            status_counts[p.status] = status_counts.get(p.status, 0) + 1

        registered_count = sum(
            status_counts.get(s, 0) for s in ("registered", "paid", "done")
        )
        done_count = status_counts.get("done", 0)
        failed_count = status_counts.get("failed", 0)
        skipped_count = status_counts.get("skipped", 0)

        models_fingerprinted = session.scalar(
            select(Model).where(Model.fingerprint_hash != None)
        )
        fp_count = session.execute(
            select(Model).where(Model.fingerprint_hash != None)
        ).fetchall().__len__()

    summary_lines = [
        "=" * 60,
        f"COORDINATOR CYCLE SUMMARY  [{_now_utc().isoformat()}]",
        "=" * 60,
        f"  Total providers discovered : {total_providers}",
        f"  Registered (incl paid/done): {registered_count}",
        f"  Done (fully fingerprinted) : {done_count}",
        f"  Failed                     : {failed_count}",
        f"  Skipped                    : {skipped_count}",
        f"  Models fingerprinted       : {fp_count}",
        "",
        "  Status breakdown:",
    ]
    for status, count in sorted(status_counts.items()):
        summary_lines.append(f"    {status:<20} {count}")
    summary_lines.append("=" * 60)

    for line in summary_lines:
        logger.info(line)


# ---------------------------------------------------------------------------
# Main orchestration cycle
# ---------------------------------------------------------------------------

def run_cycle() -> None:
    """Run one full orchestration cycle."""
    logger.info("╔══════════════════════════════════════╗")
    logger.info("║  Coordinator cycle starting           ║")
    logger.info("╚══════════════════════════════════════╝")

    # Ensure DB tables exist
    init_db()

    # --- Step 1: Discovery ---
    try:
        step_discovery()
    except Exception as exc:
        logger.error("Discovery step raised unhandled exception: %s", exc, exc_info=True)

    # --- Step 2: Registration ---
    try:
        step_registration()
    except Exception as exc:
        logger.error("Registration step raised unhandled exception: %s", exc, exc_info=True)

    # --- Step 3: Payment ---
    try:
        step_payment()
    except Exception as exc:
        logger.error("Payment step raised unhandled exception: %s", exc, exc_info=True)

    # --- Step 4: Fingerprinting ---
    try:
        step_fingerprinting()
    except Exception as exc:
        logger.error("Fingerprinting step raised unhandled exception: %s", exc, exc_info=True)

    # --- Step 5: Report ---
    try:
        step_report()
    except Exception as exc:
        logger.error("Report step raised unhandled exception: %s", exc, exc_info=True)

    logger.info("╔══════════════════════════════════════╗")
    logger.info("║  Coordinator cycle complete           ║")
    logger.info("╚══════════════════════════════════════╝")


# ---------------------------------------------------------------------------
# Entry point (cron calls this script directly)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    run_cycle()
