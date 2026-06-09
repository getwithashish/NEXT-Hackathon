"""
Model Fingerprint Verifier — FastAPI Backend
POST /fingerprint/upload  — upload .pth/.onnx, launch EC2 worker
POST /fingerprint/api     — probe API LLM via Bedrock, launch EC2 worker
GET  /job/{job_id}        — poll job status + result
GET  /models              — list known reference models
GET  /jobs                — list recent jobs
GET  /health              — liveness check
"""

import asyncio
import hashlib
import os
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from dotenv import load_dotenv

load_dotenv()

from database import AsyncSessionLocal, ModelFingerprint, KnownModel, create_tables
from s3_helper import S3Helper
from agents.ec2_orchestrator_agent import EC2OrchestratorAgent, JobSpec

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Model Fingerprint Verifier", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

s3 = S3Helper()

@app.on_event("startup")
async def on_startup():
    await create_tables()

# ── Schemas ───────────────────────────────────────────────────────────────────

class APIFingerprintRequest(BaseModel):
    api_endpoint: str
    api_key: str
    model_name: Optional[str] = "unknown"

# ── DB helpers ────────────────────────────────────────────────────────────────

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session

async def _get_fp(db: AsyncSession, job_id: str) -> Optional[ModelFingerprint]:
    result = await db.execute(select(ModelFingerprint).where(ModelFingerprint.job_id == job_id))
    return result.scalar_one_or_none()

def _find_similar(fp_data: dict, known: list) -> list:
    """Compare fingerprint against known models — simple hash match for MVP."""
    out = []
    for m in known:
        if m.fingerprint_data and fp_data:
            h1 = fp_data.get("weight_hash") or fp_data.get("behavior_hash") or ""
            h2 = (m.fingerprint_data or {}).get("weight_hash") or (m.fingerprint_data or {}).get("behavior_hash") or ""
            sim = 1.0 if (h1 and h2 and h1 == h2) else 0.0
        else:
            sim = 0.0
        out.append({"name": m.name, "source": m.source, "similarity": sim})
    out.sort(key=lambda x: x["similarity"], reverse=True)
    return out[:5]

def _verdict(similar: list) -> str:
    if not similar:
        return "uncertain"
    top = similar[0]["similarity"]
    if top > 0.90:
        return "likely_authentic"
    elif top > 0.70:
        return "possibly_distilled"
    return "suspicious"

# ── EC2 background worker ─────────────────────────────────────────────────────

def _run_ec2_sync(job_id: str, job: JobSpec):
    """Blocking — runs in a thread pool."""
    import asyncio as _asyncio
    from database import AsyncSessionLocal as _ASL, ModelFingerprint as _FP
    from sqlalchemy import select as _select

    async def _update(status, fhash=None, fdata=None):
        async with _ASL() as db:
            async with db.begin():
                r = await db.execute(_select(_FP).where(_FP.job_id == job_id))
                fp = r.scalar_one_or_none()
                if fp:
                    fp.status = status
                    if fhash: fp.fingerprint_hash = fhash
                    if fdata: fp.fingerprint_data = fdata

    _asyncio.run(_update("running"))

    try:
        agent = EC2OrchestratorAgent()
        agent.launch(job)
        result = agent.wait_for_result(job, poll_interval=10, timeout_min=25)

        if result.get("status") == "success":
            fdata = result["fingerprint"]
            fhash = (fdata.get("weight_hash") or fdata.get("behavior_hash") or
                     hashlib.sha256(str(fdata).encode()).hexdigest()[:16])
            _asyncio.run(_update("done", fhash=fhash, fdata=fdata))
        else:
            _asyncio.run(_update("error", fdata={"error": result.get("error", "Unknown")}))
    except Exception as e:
        _asyncio.run(_update("error", fdata={"error": str(e)}))

async def _run_ec2_bg(job_id: str, job: JobSpec):
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _run_ec2_sync, job_id, job)

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.post("/fingerprint/upload")
async def fingerprint_upload(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    filename = file.filename or "unknown"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ("pth", "onnx"):
        raise HTTPException(400, "Only .pth and .onnx files are supported")

    with tempfile.NamedTemporaryFile(delete=False, suffix=f".{ext}") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    file_size_mb = os.path.getsize(tmp_path) / 1e6
    job_id = str(uuid.uuid4())
    s3_key = f"models/{job_id}/{filename}"

    try:
        s3.upload_file(tmp_path, s3_key)
    finally:
        os.remove(tmp_path)

    fp = ModelFingerprint(id=str(uuid.uuid4()), job_id=job_id, model_name=filename,
                          model_type=ext, s3_model_key=s3_key, status="pending")
    db.add(fp)
    await db.commit()

    job = JobSpec(job_id=job_id, model_type=ext, s3_model_key=s3_key, model_size_mb=file_size_mb)
    background_tasks.add_task(_run_ec2_bg, job_id, job)

    return {"job_id": job_id, "status": "pending", "model_name": filename,
            "model_size_mb": round(file_size_mb, 2), "s3_key": s3_key,
            "message": "Uploaded. EC2 instance launching.", "poll_url": f"/job/{job_id}"}


@app.post("/fingerprint/api")
async def fingerprint_api(
    req: APIFingerprintRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    job_id = str(uuid.uuid4())
    fp = ModelFingerprint(id=str(uuid.uuid4()), job_id=job_id, model_name=req.model_name,
                          model_type="api", status="pending")
    db.add(fp)
    await db.commit()

    job = JobSpec(job_id=job_id, model_type="api", s3_model_key=None,
                  model_size_mb=0.0, api_endpoint=req.api_endpoint, api_key=req.api_key)
    background_tasks.add_task(_run_ec2_bg, job_id, job)

    return {"job_id": job_id, "status": "pending",
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
        similar = _find_similar(fp.fingerprint_data, known)
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
