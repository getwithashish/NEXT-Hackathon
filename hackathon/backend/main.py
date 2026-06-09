"""
Model Fingerprint Verifier — FastAPI Backend
POST /fingerprint/api                 — probe API LLM, launch Lambda worker
POST /internal/job/{job_id}/complete  — Lambda worker callback (direct, no polling)
GET  /job/{job_id}                    — poll job status + result
GET  /models                          — list known reference models
GET  /jobs                            — list recent jobs
GET  /health                          — liveness check

── New endpoints (called by Vercel Workflow steps via lib/agents/index.ts) ────
POST /agents/doc-reader               — DocReaderAgent: fetch docs URL → RequestTemplate
POST /agents/validate-template        — CustomTemplateCallerAgent.validate() test call
POST /agents/fingerprint-batch        — fingerprint one batch of 5 prompts (batch_index 0|1|2)
POST /agents/fingerprint              — full 15-prompt fingerprint (used by crawl workflow)
POST /fingerprint/compare             — compare a behavior_hash against known_models + past jobs
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
from agents.api_caller_agent import ApiCallerAgent, CustomTemplateCallerAgent

log = logging.getLogger(__name__)

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Model Fingerprint Verifier", version="2.0.0")
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
    request_template: Optional[dict] = None
    doc_url: Optional[str] = None

# ── DB helpers ────────────────────────────────────────────────────────────────

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session

async def _get_fp(db: AsyncSession, job_id: str) -> Optional[ModelFingerprint]:
    result = await db.execute(select(ModelFingerprint).where(ModelFingerprint.job_id == job_id))
    return result.scalar_one_or_none()

def _behavior_hash(fp_data: dict) -> str:
    bsig = fp_data.get("behavioral_signature", {})
    return (bsig.get("behavior_hash") or
            fp_data.get("behavior_hash") or
            fp_data.get("weight_hash") or
            fp_data.get("composite_hash") or "")

def _find_similar(fp_data: dict, known_models: list, past_jobs: list) -> list:
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
                        "similarity": sim, "from": "past_jobs", "job_id": j.job_id})
    out.sort(key=lambda x: x["similarity"], reverse=True)
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

# ── Lambda background task ────────────────────────────────────────────────────

async def _launch_lambda(job_id: str, job: JobSpec) -> None:
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
        await _upsert_known_model(db, fp)
    else:
        fp.status           = "error"
        fp.fingerprint_data = {"error": payload.error or "Worker reported failure"}
    await db.commit()
    return {"ok": True}

# ── Original routes ───────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.post("/fingerprint/api")
async def fingerprint_api(
    req: APIFingerprintRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    resolved_template: Optional[dict] = None
    template_source = "auto"
    loop = asyncio.get_event_loop()

    if req.request_template:
        template_source = "user_provided"
        caller = CustomTemplateCallerAgent(
            req.request_template, api_key=req.api_key or "", model_hint=req.model_hint or "")
        ok, sample, resolved = await loop.run_in_executor(None, caller.validate)
        if not ok:
            raise HTTPException(400, f"request_template validation failed: {sample}")
        resolved_template = resolved
    elif req.doc_url:
        template_source = "doc_reader"
        try:
            agent = DocReaderAgent()
            template = await loop.run_in_executor(None, agent.extract_template_from_url, req.doc_url)
            ok, sample, resolved = await loop.run_in_executor(
                None, lambda: agent.validate_and_discover(
                    template, api_key=req.api_key or "", model_hint=req.model_hint or ""))
            if not ok:
                raise HTTPException(422, f"DocReaderAgent template test call failed: {sample}")
            resolved_template = resolved
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(422, f"Failed to read/parse doc at {req.doc_url}: {e}")

    job_id = str(uuid.uuid4())
    fp = ModelFingerprint(id=str(uuid.uuid4()), job_id=job_id,
                          model_name=req.model_name, model_type="api", status="pending")
    db.add(fp)
    await db.commit()

    job = JobSpec(job_id=job_id, model_type="api", s3_model_key=None,
                  model_size_mb=0.0, api_endpoint=req.api_endpoint, api_key=req.api_key,
                  model_hint=req.model_hint, request_template=resolved_template)
    background_tasks.add_task(_launch_lambda, job_id, job)
    return {"job_id": job_id, "status": "pending", "template_source": template_source,
            "message": "EC2 launching to probe API model.", "poll_url": f"/job/{job_id}"}


@app.get("/job/{job_id}")
async def get_job(job_id: str, db: AsyncSession = Depends(get_db)):
    fp = await _get_fp(db, job_id)
    if not fp:
        raise HTTPException(404, f"Job {job_id} not found")
    similar, verdict = [], None
    if fp.status == "done" and fp.fingerprint_data:
        r = await db.execute(select(KnownModel))
        known = r.scalars().all()
        r2 = await db.execute(
            select(ModelFingerprint).where(ModelFingerprint.status == "done").where(
                ModelFingerprint.job_id != job_id))
        past_jobs = r2.scalars().all()
        similar = _find_similar(fp.fingerprint_data, known, past_jobs)
        verdict = _verdict(similar)
    return {"job_id": fp.job_id, "status": fp.status, "model_type": fp.model_type,
            "model_name": fp.model_name, "fingerprint_hash": fp.fingerprint_hash,
            "fingerprint_data": fp.fingerprint_data, "similar_models": similar,
            "verdict": verdict, "created_at": fp.created_at.isoformat()}


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


# ═════════════════════════════════════════════════════════════════════════════
# NEW: Agent endpoints called by Vercel Workflow steps
# These are thin HTTP wrappers around the existing Python agent classes.
# The Vercel backend (TypeScript) calls these from lib/agents/index.ts.
# ═════════════════════════════════════════════════════════════════════════════

# Prompt battery — 20 diverse prompts, split into 3 batches
DIVERSE_PROMPTS = [
    # Factual / knowledge (batch 0: indices 0–4)
    "What is the speed of light in a vacuum?",
    "Explain the Pythagorean theorem in one sentence.",
    "Name the capital cities of France, Germany, and Japan.",
    "What year did the Berlin Wall fall?",
    "How many bones are in the adult human body?",
    # Reasoning / math (batch 1: indices 5–9)
    "If a train travels 60 mph for 2.5 hours, how far does it go?",
    "What is the square root of 144?",
    "A rectangle has length 8 and width 5. What is its area?",
    "Which is larger: 7/8 or 5/6?",
    "If x + 3 = 10, what is x?",
    # Creative / open-ended (batch 2: indices 10–14)
    "Write a one-sentence story about a robot who discovers music.",
    "Give me a haiku about the ocean.",
    "Describe the color blue to someone who has never seen it.",
    "Invent a name for a new planet and explain what it looks like.",
    "Write a one-line motto for a bakery.",
]

BATCH_SIZE = 5  # 3 batches of 5 = 15 total

import statistics


def _compute_partial_signature(results: list[dict]) -> dict:
    responses = [r["response"] for r in results if not r["error"]]
    latencies = [r["latency"] for r in results if not r["error"]]
    lengths   = [len(r) for r in responses]
    return {
        "avg_response_length": statistics.mean(lengths) if lengths else 0,
        "std_response_length": statistics.stdev(lengths) if len(lengths) > 1 else 0,
        "avg_latency_ms":      round(statistics.mean(latencies) * 1000, 1) if latencies else 0,
        "top_vocab": _top_vocab(responses),
        "sample_count": len(responses),
    }


def _top_vocab(responses: list[str], top_n: int = 10) -> list[str]:
    from collections import Counter
    words = []
    for r in responses:
        words.extend(
            w.strip(".,!?;:\"'()[]{}").lower()
            for w in r.split()
            if len(w.strip(".,!?;:\"'()[]{}")) > 2
        )
    return [w for w, _ in Counter(words).most_common(top_n)]


# ── /agents/doc-reader ────────────────────────────────────────────────────────

class DocReaderRequest(BaseModel):
    doc_url: str
    api_key: str = ""

@app.post("/agents/doc-reader")
async def agent_doc_reader(req: DocReaderRequest):
    """
    Fetch a provider's documentation URL and extract a RequestTemplate using
    DocReaderAgent (Exa + Claude Bedrock).
    """
    loop = asyncio.get_event_loop()
    try:
        agent = DocReaderAgent()
        template = await loop.run_in_executor(None, agent.extract_template_from_url, req.doc_url)
        return template.to_dict()
    except Exception as e:
        raise HTTPException(422, f"DocReaderAgent failed: {e}")


# ── /agents/validate-template ─────────────────────────────────────────────────

class ValidateTemplateRequest(BaseModel):
    template: dict
    api_key: str = ""
    model_hint: str = ""

@app.post("/agents/validate-template")
async def agent_validate_template(req: ValidateTemplateRequest):
    """
    Make a single test call using CustomTemplateCallerAgent.validate() to
    verify the template works and auto-discover response_path.
    Returns the resolved template dict (with response_path filled in).
    """
    loop = asyncio.get_event_loop()
    try:
        caller = CustomTemplateCallerAgent(
            req.template, api_key=req.api_key, model_hint=req.model_hint)
        ok, text, resolved = await loop.run_in_executor(None, caller.validate)
        if not ok:
            raise HTTPException(400, f"Template validation failed: {text}")
        return resolved
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(422, f"validate-template error: {e}")


# ── /agents/fingerprint-batch ─────────────────────────────────────────────────

class FingerprintBatchRequest(BaseModel):
    batch_index: int          # 0, 1, or 2
    api_endpoint: str
    api_key: str
    model_hint: str = ""
    request_template: Optional[dict] = None

@app.post("/agents/fingerprint-batch")
async def agent_fingerprint_batch(req: FingerprintBatchRequest):
    """
    Run one batch of 5 prompts (batch_index 0→prompts 1-5, 1→6-10, 2→11-15).
    Called 3× by the Vercel Workflow, once per step, to avoid the 300s timeout.
    Returns partial responses + a partial behavioral signature.
    """
    if req.batch_index not in (0, 1, 2):
        raise HTTPException(400, "batch_index must be 0, 1, or 2")

    start = req.batch_index * BATCH_SIZE
    batch_prompts = DIVERSE_PROMPTS[start : start + BATCH_SIZE]

    loop = asyncio.get_event_loop()

    def run_batch():
        if req.request_template:
            caller = CustomTemplateCallerAgent(
                req.request_template, api_key=req.api_key, model_hint=req.model_hint)
            return caller.call_batch(batch_prompts)
        else:
            caller = ApiCallerAgent(req.api_endpoint, req.api_key)
            return caller.call_batch(batch_prompts, model_hint=req.model_hint)

    try:
        results = await loop.run_in_executor(None, run_batch)
    except Exception as e:
        raise HTTPException(500, f"fingerprint-batch[{req.batch_index}] failed: {e}")

    responses = [r["response"] for r in results]
    return {
        "responses": responses,
        "partial_signature": _compute_partial_signature(results),
    }


# ── /agents/fingerprint (full — used by crawl-fingerprint workflow) ───────────

class FingerprintFullRequest(BaseModel):
    api_endpoint: str
    api_key: str
    model_hint: str = ""
    request_template: Optional[dict] = None

@app.post("/agents/fingerprint")
async def agent_fingerprint_full(req: FingerprintFullRequest):
    """
    Run all 15 prompts in one call (for the crawl-fingerprint workflow which
    runs on a long Vercel step). Returns full behavioral signature + hash.
    """
    loop = asyncio.get_event_loop()

    def run_all():
        if req.request_template:
            caller = CustomTemplateCallerAgent(
                req.request_template, api_key=req.api_key, model_hint=req.model_hint)
            return caller.call_batch(DIVERSE_PROMPTS)
        else:
            caller = ApiCallerAgent(req.api_endpoint, req.api_key)
            return caller.call_batch(DIVERSE_PROMPTS, model_hint=req.model_hint)

    try:
        results = await loop.run_in_executor(None, run_all)
    except Exception as e:
        raise HTTPException(500, f"fingerprint full run failed: {e}")

    responses    = [r["response"] for r in results if not r["error"]]
    latencies    = [r["latency"]  for r in results if not r["error"]]
    lengths      = [len(r)        for r in responses]

    if not responses:
        errors = [r["error"] for r in results if r["error"]]
        raise HTTPException(500, f"All API calls failed. First error: {errors[0] if errors else 'unknown'}")

    combined = "\n---\n".join(responses)
    behavior_hash = hashlib.sha256(combined.encode("utf-8")).hexdigest()

    return {
        "behavior_hash": behavior_hash,
        "behavioral_signature": {
            "behavior_hash":       behavior_hash,
            "avg_response_length": statistics.mean(lengths) if lengths else 0,
            "std_response_length": statistics.stdev(lengths) if len(lengths) > 1 else 0,
            "avg_latency_ms":      round(statistics.mean(latencies) * 1000, 1) if latencies else 0,
            "top_vocab":           _top_vocab(responses),
            "sample_count":        len(responses),
        },
        "model_name": req.model_hint or "unknown",
        "duration_seconds": sum(r["latency"] for r in results),
    }


# ── /fingerprint/compare ─────────────────────────────────────────────────────

class CompareRequest(BaseModel):
    behavior_hash: str

@app.post("/fingerprint/compare")
async def fingerprint_compare(req: CompareRequest, db: AsyncSession = Depends(get_db)):
    """
    Compare a behavior_hash against:
      1. known_models table (seeded reference fingerprints)
      2. past completed jobs in model_fingerprints
    Returns top-5 similar models + a verdict string.
    """
    fp_data = {"behavior_hash": req.behavior_hash}

    r = await db.execute(select(KnownModel))
    known = r.scalars().all()

    r2 = await db.execute(
        select(ModelFingerprint).where(ModelFingerprint.status == "done"))
    past_jobs = r2.scalars().all()

    similar = _find_similar(fp_data, known, past_jobs)
    verdict = _verdict(similar)

    return {"similar_models": similar, "verdict": verdict}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=os.getenv("BACKEND_HOST", "0.0.0.0"),
                port=int(os.getenv("BACKEND_PORT", 8000)),
                log_level="info")
