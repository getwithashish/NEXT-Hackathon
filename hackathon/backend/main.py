"""
Model Fingerprint Verifier — FastAPI Backend
POST /fingerprint/api                 — probe API LLM, launch Lambda worker
POST /internal/job/{job_id}/complete  — Lambda worker callback (direct, no polling)
GET  /job/{job_id}                    — poll job status + result
GET  /models                          — list known reference models
GET  /jobs                            — list recent jobs
GET  /health                          — liveness check
"""

import asyncio
import hashlib
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from dotenv import load_dotenv

load_dotenv()

from database import AsyncSessionLocal, ModelFingerprint, KnownModel, create_tables
from agents.lambda_orchestrator import LambdaOrchestratorAgent, JobSpec
from agents.doc_reader_agent import DocReaderAgent, RequestTemplate

log = logging.getLogger(__name__)

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Model Fingerprint Verifier", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
async def on_startup():
    await create_tables()

# ── Schemas ───────────────────────────────────────────────────────────────────

class APIFingerprintRequest(BaseModel):
    api_endpoint: str
    api_key: str
    model_name: Optional[str] = "unknown"
    model_hint: Optional[str] = ""

    # ── Option 1: user constructs the request (Postman-style) ──────────────
    # The AI auto-discovers how to read the response — never specify response_path.
    request_template: Optional[dict] = None
    # Supported fields:
    #   url             — endpoint URL. Placeholders: {api_key}, {model}
    #   method          — HTTP method (default: POST)
    #   headers         — dict of headers. {api_key} is substituted.
    #   body_template   — JSON body. Placeholders: {prompt}, {api_key}, {model}
    #   auth_type       — bearer (default) | header | query_param | basic | aws_sigv4 | none
    #   query_params    — extra URL query params (non-auth), e.g. {"api-version": "2024-01"}
    #   content_type    — body encoding (default: application/json)
    #   auth_param_name — (query_param only) URL param name for key, default "api_key"
    #   username        — (basic only) username; api_key is the password
    #   aws_region      — (aws_sigv4 only) AWS region
    #   aws_service     — (aws_sigv4 only) AWS service, default "execute-api"

    # ── Option 2: user provides a doc URL (AI does everything) ─────────────
    # DocReaderAgent fetches the page, Claude extracts the template, AI discovers response.
    doc_url: Optional[str] = None

# ── DB helpers ────────────────────────────────────────────────────────────────

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session

async def _get_fp(db: AsyncSession, job_id: str) -> Optional[ModelFingerprint]:
    result = await db.execute(select(ModelFingerprint).where(ModelFingerprint.job_id == job_id))
    return result.scalar_one_or_none()

def _behavior_hash(fp_data: dict) -> str:
    """Extract the canonical fingerprint hash from any result shape."""
    bsig = fp_data.get("behavioral_signature", {})
    return (bsig.get("behavior_hash") or
            fp_data.get("behavior_hash") or
            fp_data.get("weight_hash") or
            fp_data.get("composite_hash") or "")

def _find_similar(fp_data: dict, known_models: list, past_jobs: list) -> list:
    """
    Compare fingerprint against:
      1. known_models table (seeded reference entries with fingerprints)
      2. past completed jobs in model_fingerprints (real verified runs)
    Returns top-5 by similarity score.
    """
    h1 = _behavior_hash(fp_data)
    out = []

    for m in known_models:
        if m.fingerprint_data:
            h2 = _behavior_hash(m.fingerprint_data)
            sim = 1.0 if (h1 and h2 and h1 == h2) else 0.0
            out.append({"name": m.name, "source": m.source, "similarity": sim,
                        "from": "known_models"})

    for j in past_jobs:
        if j.fingerprint_data and j.fingerprint_hash:
            h2 = _behavior_hash(j.fingerprint_data)
            sim = 1.0 if (h1 and h2 and h1 == h2) else 0.0
            out.append({"name": j.model_name, "source": "verified_job",
                        "similarity": sim, "from": "past_jobs",
                        "job_id": j.job_id})

    out.sort(key=lambda x: x["similarity"], reverse=True)
    # Deduplicate by name, keep highest similarity
    seen, deduped = set(), []
    for item in out:
        if item["name"] not in seen:
            seen.add(item["name"])
            deduped.append(item)
    return deduped[:5]

def _verdict(similar: list) -> str:
    if not similar:
        return "uncertain"
    top = similar[0]["similarity"]
    if top >= 1.0:
        return "likely_authentic"
    elif top > 0.70:
        return "possibly_distilled"
    return "suspicious"

async def _upsert_known_model(db: AsyncSession, fp: ModelFingerprint) -> None:
    """
    After a successful fingerprint job, save/update the model in known_models
    so future jobs can match against it.
    """
    r = await db.execute(select(KnownModel).where(KnownModel.name == fp.model_name))
    existing = r.scalar_one_or_none()
    if existing:
        existing.fingerprint_hash = fp.fingerprint_hash
        existing.fingerprint_data = fp.fingerprint_data
    else:
        db.add(KnownModel(
            id=str(uuid.uuid4()),
            name=fp.model_name,
            source="user_verified",
            fingerprint_hash=fp.fingerprint_hash,
            fingerprint_data=fp.fingerprint_data,
        ))

# ── Lambda background task — fire and forget ─────────────────────────────────
# Worker POSTs back to POST /internal/job/{job_id}/complete when done.
# No polling, no blocking thread.

async def _launch_lambda(job_id: str, job: JobSpec) -> None:
    """Background task: invoke Lambda asynchronously."""
    db_gen = get_db()
    db = await db_gen.__anext__()
    try:
        fp = await _get_fp(db, job_id)
        if not fp:
            log.error("_launch_lambda: job %s not found in DB", job_id)
            return
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(None, lambda: LambdaOrchestratorAgent().launch(job))
            fp.status = "running"
            log.info("Lambda invoked for job %s", job_id)
        except Exception as exc:
            fp.status = "error"
            fp.error_message = str(exc)
            log.exception("Lambda invoke failed for job %s", job_id)
        await db.commit()
    finally:
        await db_gen.aclose()

# ── Internal callback endpoint (called by EC2 worker) ────────────────────────

class JobCompletePayload(BaseModel):
    status: str
    fingerprint_data: Optional[dict] = None
    error: Optional[str] = None
    responses_s3_key: Optional[str] = None

@app.post("/internal/job/{job_id}/complete")
async def job_complete(job_id: str, payload: JobCompletePayload,
                       db: AsyncSession = Depends(get_db)):
    """Called directly by the EC2 worker — result goes straight into DB."""
    fp = await _get_fp(db, job_id)
    if not fp:
        raise HTTPException(404, f"Job {job_id} not found")

    if payload.status == "success" and payload.fingerprint_data:
        fdata = payload.fingerprint_data
        bsig  = fdata.get("behavioral_signature", {})
        fhash = (bsig.get("behavior_hash") or
                 fdata.get("weight_hash") or
                 fdata.get("composite_hash") or
                 hashlib.sha256(str(fdata).encode()).hexdigest()[:16])
        if payload.responses_s3_key:
            fdata["responses_s3_key"] = payload.responses_s3_key
        fp.status           = "done"
        fp.fingerprint_hash = fhash
        fp.fingerprint_data = fdata
        await db.commit()
        # Save to known_models so future jobs can match against it
        await _upsert_known_model(db, fp)
    else:
        fp.status           = "error"
        fp.fingerprint_data = {"error": payload.error or "Worker reported failure"}

    await db.commit()
    return {"ok": True}

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.post("/fingerprint/api")
async def fingerprint_api(
    req: APIFingerprintRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """
    Submit an API-based model for fingerprinting.

    Template resolution order (runs synchronously BEFORE EC2 launches):
      1. request_template provided  → validate + auto-discover response_path
      2. doc_url provided           → DocReaderAgent reads docs, extracts template,
                                      validate + auto-discover response_path
      3. neither                    → ApiCallerAgent auto-detection on EC2 worker

    In all cases, response_path is NEVER required from the user.
    """
    from agents.api_caller_agent import CustomTemplateCallerAgent

    resolved_template: Optional[dict] = None
    template_source = "auto"

    loop = asyncio.get_event_loop()

    # ── Path 1: user provided request template ────────────────────────────────
    if req.request_template:
        template_source = "user_provided"
        caller = CustomTemplateCallerAgent(
            req.request_template,
            api_key=req.api_key or "",
            model_hint=req.model_hint or "",
        )
        ok, sample, resolved = await loop.run_in_executor(None, caller.validate)
        if not ok:
            raise HTTPException(400,
                f"request_template validation failed: {sample}. "
                "Check your url, method, headers, body_template and auth_type.")
        log.info("User template OK. auth=%s response_path=%s sample=%s",
                 resolved.get("auth_type"), resolved.get("response_path"), sample[:60])
        resolved_template = resolved   # has response_path filled in

    # ── Path 2: user provided doc URL ─────────────────────────────────────────
    elif req.doc_url:
        template_source = "doc_reader"
        try:
            agent = DocReaderAgent()
            template = await loop.run_in_executor(
                None, agent.extract_template_from_url, req.doc_url
            )
            ok, sample, resolved = await loop.run_in_executor(
                None,
                lambda: agent.validate_and_discover(
                    template, api_key=req.api_key or "", model_hint=req.model_hint or ""
                ),
            )
            if not ok:
                raise HTTPException(422,
                    f"DocReaderAgent read {req.doc_url} and extracted a template "
                    f"but the test call failed: {sample}. "
                    "Try providing request_template directly instead.")
            log.info("Doc template OK. url=%s auth=%s response_path=%s",
                     template.url, template.auth_type, template.response_path)
            resolved_template = resolved   # has response_path filled in
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(422, f"Failed to read/parse doc at {req.doc_url}: {e}")

    # ── Create job + launch EC2 ───────────────────────────────────────────────
    job_id = str(uuid.uuid4())
    fp = ModelFingerprint(
        id=str(uuid.uuid4()), job_id=job_id,
        model_name=req.model_name, model_type="api", status="pending",
    )
    db.add(fp)
    await db.commit()

    job = JobSpec(
        job_id=job_id, model_type="api", s3_model_key=None,
        model_size_mb=0.0, api_endpoint=req.api_endpoint, api_key=req.api_key,
        model_hint=req.model_hint, request_template=resolved_template,
    )
    background_tasks.add_task(_launch_lambda, job_id, job)

    return {
        "job_id":          job_id,
        "status":          "pending",
        "template_source": template_source,
        "message":         "EC2 launching to probe API model.",
        "poll_url":        f"/job/{job_id}",
    }


@app.get("/job/{job_id}")
async def get_job(job_id: str, db: AsyncSession = Depends(get_db)):
    fp = await _get_fp(db, job_id)
    if not fp:
        raise HTTPException(404, f"Job {job_id} not found")

    similar, verdict = [], None
    if fp.status == "done" and fp.fingerprint_data:
        r = await db.execute(select(KnownModel))
        known = r.scalars().all()
        # Also query past successful jobs (excluding this one) as reference
        r2 = await db.execute(
            select(ModelFingerprint)
            .where(ModelFingerprint.status == "done")
            .where(ModelFingerprint.job_id != job_id)
        )
        past_jobs = r2.scalars().all()
        similar = _find_similar(fp.fingerprint_data, known, past_jobs)
        verdict = _verdict(similar)

    return {
        "job_id": fp.job_id, "status": fp.status,
        "model_type": fp.model_type, "model_name": fp.model_name,
        "fingerprint_hash": fp.fingerprint_hash, "fingerprint_data": fp.fingerprint_data,
        "similar_models": similar, "verdict": verdict,
        "created_at": fp.created_at.isoformat(),
    }


@app.get("/models")
async def list_models(db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(KnownModel))
    models = r.scalars().all()
    return {"total": len(models),
            "models": [{"name": m.name, "source": m.source,
                        "has_fingerprint": m.fingerprint_data is not None} for m in models]}


@app.get("/jobs")
async def list_jobs(db: AsyncSession = Depends(get_db)):
    r = await db.execute(
        select(ModelFingerprint).order_by(ModelFingerprint.created_at.desc()).limit(20))
    jobs = r.scalars().all()
    return {"jobs": [{"job_id": j.job_id, "model_name": j.model_name,
                      "model_type": j.model_type, "status": j.status,
                      "created_at": j.created_at.isoformat()} for j in jobs]}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=os.getenv("BACKEND_HOST", "0.0.0.0"),
                port=int(os.getenv("BACKEND_PORT", 8000)),
                log_level="info")
