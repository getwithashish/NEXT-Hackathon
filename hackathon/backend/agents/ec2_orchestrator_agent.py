"""
EC2 Orchestrator Agent
======================
Decides the right EC2 instance type for a given model, spins it up,
runs the fingerprinting worker, collects results from S3, then TERMINATES
the instance — no resources left idle.

Decision logic:
  .onnx / .pth < 500 MB   → CPU  → t3.xlarge    (4 vCPU, 16 GB RAM)
  .pth 500 MB – 4 GB      → CPU  → c5.2xlarge    (8 vCPU, 16 GB RAM)
  .pth > 4 GB             → GPU  → g4dn.xlarge   (1x T4 GPU, 16 GB RAM)
  API-based model         → CPU  → t3.medium     (behavioral probing only)

All instances run the worker script via EC2 user-data, POST results back to
the backend callback endpoint, then self-terminate.
"""

import boto3
import time
import json
import os
import base64
import hashlib
from typing import Optional
from dataclasses import dataclass, field
from enum import Enum

# ── Configuration ──────────────────────────────────────────────────────────────

S3_BUCKET        = os.getenv("AWS_S3_BUCKET", "model-fingerprint-verify-models-1780978543")
AWS_REGION       = os.getenv("AWS_REGION", "us-east-1")
SECURITY_GROUP   = os.getenv("SECURITY_GROUP_ID", "sg-02acfced4475f51f4")
KEY_NAME         = "model-fingerprint-key"
INSTANCE_PROFILE = "model-fingerprint-ec2-profile"

# Deep Learning AMI (Amazon Linux 2, pre-installed CUDA + PyTorch + ONNX Runtime)
# us-east-1 public DLAMI — update if region changes
DLAMI_ID   = "ami-0453ec754f44f9a4a"   # Amazon Deep Learning AMI (AL2), us-east-1
PLAIN_AMI  = "ami-0453ec754f44f9a4a"   # Same DLAMI works for CPU too

# ── Data classes ───────────────────────────────────────────────────────────────

class InstanceClass(str, Enum):
    CPU_SMALL  = "t3.medium"       # API probing
    CPU_MEDIUM = "t3.xlarge"       # small local models
    CPU_LARGE  = "c5.2xlarge"      # medium local models
    GPU        = "g4dn.xlarge"     # large / GPU models

@dataclass
class InstanceConfig:
    instance_type: str
    ami_id: str
    reason: str
    estimated_minutes: int
    spot: bool = True              # use spot to cut costs ~70%

@dataclass
class JobSpec:
    job_id: str
    model_type: str                # "api" | "pth" | "onnx"
    s3_model_key: Optional[str]    # None for API jobs
    model_size_mb: float = 0.0
    api_endpoint: Optional[str] = None
    api_key: Optional[str] = None
    model_hint: Optional[str] = None
    request_template: Optional[dict] = None  # pre-resolved Postman-style template

    result_s3_key: str = field(init=False)

    def __post_init__(self):
        self.result_s3_key = f"results/{self.job_id}/fingerprint.json"

# ── Orchestrator ───────────────────────────────────────────────────────────────

class EC2OrchestratorAgent:
    """
    Decides instance config, launches EC2, monitors job, collects results,
    terminates instance.
    """

    def __init__(self):
        self.ec2     = boto3.client("ec2",  region_name=AWS_REGION)
        self.s3      = boto3.client("s3",   region_name=AWS_REGION)
        self.ssm     = boto3.client("ssm",  region_name=AWS_REGION)
        self.running_instances: dict[str, str] = {}   # job_id → instance_id

    # ── 1. Decide instance type ─────────────────────────────────────────────

    def decide_instance(self, job: JobSpec) -> InstanceConfig:
        """Rule-based instance selection — no wasted resources."""
        if job.model_type == "api":
            return InstanceConfig(
                instance_type=InstanceClass.CPU_SMALL,
                ami_id=PLAIN_AMI,
                reason="API-based model: behavioral probing only, no heavy compute",
                estimated_minutes=5,
                spot=True,
            )

        size = job.model_size_mb

        if size < 500:
            return InstanceConfig(
                instance_type=InstanceClass.CPU_MEDIUM,
                ami_id=PLAIN_AMI,
                reason=f"Small model ({size:.0f} MB): weight hash + layer stats, CPU sufficient",
                estimated_minutes=5,
                spot=True,
            )
        elif size < 4096:
            return InstanceConfig(
                instance_type=InstanceClass.CPU_LARGE,
                ami_id=PLAIN_AMI,
                reason=f"Medium model ({size:.0f} MB): activation analysis needs more CPU/RAM",
                estimated_minutes=12,
                spot=True,
            )
        else:
            return InstanceConfig(
                instance_type=InstanceClass.GPU,
                ami_id=DLAMI_ID,
                reason=f"Large model ({size:.0f} MB): GPU needed for forward-pass activation probing",
                estimated_minutes=20,
                spot=False,   # GPU spot can be interrupted; on-demand for reliability
            )

    # ── 2. Build user-data script ────────────────────────────────────────────

    def _build_user_data(self, job: JobSpec, cfg: InstanceConfig) -> str:
        """
        Shell script injected as EC2 user-data.
        Runs on boot, does the work, POSTs result to backend, self-terminates.
        """
        import json as _json
        exa_key      = os.getenv("EXA_API_KEY", "")
        backend_url  = os.getenv("BACKEND_URL", "http://54.86.179.209:8000")
        # Serialize template as single-quoted JSON (safe for bash export)
        request_template_json = (
            "'" + _json.dumps(job.request_template or {}).replace("'", "'\\''") + "'"
        )
        script = f"""#!/bin/bash
set -e
exec > /var/log/fingerprint-worker.log 2>&1

echo "[$(date)] Worker starting — job {job.job_id}"

# Ensure pip is available
dnf install -y python3-pip --quiet 2>&1 || true

# Install deps
python3 -m pip install boto3 numpy scipy scikit-learn onnxruntime exa-py --quiet --ignore-installed 2>&1

# Pull worker scripts from S3
/usr/bin/aws s3 cp s3://{S3_BUCKET}/scripts/fingerprint_worker.py /tmp/fingerprint_worker.py
/usr/bin/aws s3 cp s3://{S3_BUCKET}/scripts/api_caller_agent.py /tmp/api_caller_agent.py
/usr/bin/aws s3 cp s3://{S3_BUCKET}/scripts/doc_reader_agent.py /tmp/doc_reader_agent.py

# Set environment
export AWS_S3_BUCKET="{S3_BUCKET}"
export AWS_DEFAULT_REGION="{AWS_REGION}"
export JOB_ID="{job.job_id}"
export MODEL_TYPE="{job.model_type}"
export S3_MODEL_KEY="{job.s3_model_key or ''}"
export RESULT_S3_KEY="{job.result_s3_key}"
export API_ENDPOINT="{job.api_endpoint or ''}"
export API_KEY="{job.api_key or ''}"
export MODEL_HINT="{job.model_hint or ''}"
export EXA_API_KEY="{exa_key}"
export BACKEND_URL="{backend_url}"
export RESPONSES_S3_KEY="results/{job.job_id}/responses.json"
export REQUEST_TEMPLATE={request_template_json}

# Run fingerprinting
/usr/bin/python3 /tmp/fingerprint_worker.py

echo "[$(date)] Worker done — self-terminating instance"

# Self-terminate (IMDSv2 requires token)
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
/usr/bin/aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region {AWS_REGION}
"""
        return script  # boto3 run_instances handles base64 encoding internally

    # ── 3. Launch instance ───────────────────────────────────────────────────

    def launch(self, job: JobSpec) -> dict:
        """
        Launch EC2 instance for this job.
        Returns immediately with instance_id; poll with wait_for_result().
        """
        cfg = self.decide_instance(job)
        user_data = self._build_user_data(job, cfg)

        # First upload worker script to S3 (idempotent)
        self._ensure_worker_script_on_s3()

        launch_kwargs = dict(
            ImageId=cfg.ami_id,
            InstanceType=cfg.instance_type,
            KeyName=KEY_NAME,
            SecurityGroupIds=[SECURITY_GROUP],
            UserData=user_data,
            MinCount=1,
            MaxCount=1,
            IamInstanceProfile={"Name": INSTANCE_PROFILE},
            TagSpecifications=[{
                "ResourceType": "instance",
                "Tags": [
                    {"Key": "Name",   "Value": f"fingerprint-worker-{job.job_id[:8]}"},
                    {"Key": "Project","Value": "model-fingerprint-verify"},
                    {"Key": "JobId",  "Value": job.job_id},
                ]
            }],
            InstanceInitiatedShutdownBehavior="terminate",
        )

        # Use spot for cost savings when flagged
        if cfg.spot and cfg.instance_type != InstanceClass.GPU:
            launch_kwargs["InstanceMarketOptions"] = {
                "MarketType": "spot",
                "SpotOptions": {"SpotInstanceType": "one-time"},
            }

        response = self.ec2.run_instances(**launch_kwargs)
        instance_id = response["Instances"][0]["InstanceId"]
        self.running_instances[job.job_id] = instance_id

        print(f"✅ Launched {cfg.instance_type} instance: {instance_id}")
        print(f"   Reason: {cfg.reason}")
        print(f"   Est. completion: ~{cfg.estimated_minutes} min")
        print(f"   Results will appear at: s3://{S3_BUCKET}/{job.result_s3_key}")

        return {
            "job_id": job.job_id,
            "instance_id": instance_id,
            "instance_type": cfg.instance_type,
            "reason": cfg.reason,
            "estimated_minutes": cfg.estimated_minutes,
            "result_s3_key": job.result_s3_key,
            "status": "launched",
        }

    # ── 4. (Removed) Poll for result ─────────────────────────────────────────
    # Result now arrives via direct HTTP callback: worker POSTs to
    # POST /internal/job/{job_id}/complete on the backend server.
    # No S3 polling, no waiting. This method kept as a stub for CLI tests.

    def wait_for_result(self, job: JobSpec, poll_interval: int = 15, timeout_min: int = 30) -> dict:
        """Deprecated — result now arrives via direct callback. Stub for compat."""
        print("ℹ️  wait_for_result() is deprecated — worker posts result directly to backend")
        return {"status": "pending", "job_id": job.job_id}

    # ── 5. Force-terminate (emergency cleanup) ───────────────────────────────

    def terminate(self, job_id: str):
        """Forcefully terminate an instance (normally instances self-terminate)."""
        iid = self.running_instances.get(job_id)
        if not iid:
            print(f"No running instance for job {job_id}")
            return
        self.ec2.terminate_instances(InstanceIds=[iid])
        print(f"🗑️  Terminated instance {iid} for job {job_id}")

    # ── 6. Upload worker script to S3 ────────────────────────────────────────

    def _ensure_worker_script_on_s3(self):
        """Upload the fingerprint_worker.py to S3 if not already there."""
        worker_path = os.path.join(os.path.dirname(__file__), "fingerprint_worker.py")
        if not os.path.exists(worker_path):
            worker_path = "/root/fingerprint_worker.py"

        try:
            self.s3.head_object(Bucket=S3_BUCKET, Key="scripts/fingerprint_worker.py")
            # Already exists — skip upload unless forced
        except:
            print("📤 Uploading worker script to S3...")
            self.s3.upload_file(worker_path, S3_BUCKET, "scripts/fingerprint_worker.py")
            print("✅ Worker script uploaded")

    # ── 7. List running jobs ──────────────────────────────────────────────────

    def list_jobs(self) -> list:
        """List all instances tagged for this project."""
        response = self.ec2.describe_instances(Filters=[
            {"Name": "tag:Project", "Values": ["model-fingerprint-verify"]},
            {"Name": "instance-state-name", "Values": ["pending", "running"]}
        ])
        jobs = []
        for r in response["Reservations"]:
            for inst in r["Instances"]:
                tags = {t["Key"]: t["Value"] for t in inst.get("Tags", [])}
                jobs.append({
                    "instance_id": inst["InstanceId"],
                    "state": inst["State"]["Name"],
                    "type": inst["InstanceType"],
                    "job_id": tags.get("JobId", "unknown"),
                    "launched": str(inst["LaunchTime"]),
                })
        return jobs


# ── High-level convenience function (used by FastAPI) ─────────────────────────

def run_fingerprint_job(
    model_type: str,
    s3_model_key: Optional[str] = None,
    model_size_mb: float = 0.0,
    api_endpoint: Optional[str] = None,
    api_key: Optional[str] = None,
    wait: bool = False,
) -> dict:
    """
    One-call interface for FastAPI endpoint:
      - Builds JobSpec
      - Decides instance
      - Launches EC2
      - Optionally waits for result

    If wait=False (default), returns immediately with job metadata.
    If wait=True, blocks until fingerprint result is ready.
    """
    import uuid
    job = JobSpec(
        job_id=str(uuid.uuid4()),
        model_type=model_type,
        s3_model_key=s3_model_key,
        model_size_mb=model_size_mb,
        api_endpoint=api_endpoint,
        api_key=api_key,
    )

    agent = EC2OrchestratorAgent()
    launch_info = agent.launch(job)

    if wait:
        result = agent.wait_for_result(job)
        return {**launch_info, "result": result, "status": "completed"}

    return launch_info


# ── CLI smoke test ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys

    agent = EC2OrchestratorAgent()

    # Show instance selection decisions for various model sizes
    print("=== Instance Selection Decisions ===\n")
    test_cases = [
        JobSpec("job-1", "api",  None, 0),
        JobSpec("job-2", "pth",  "models/small.pth",  200),
        JobSpec("job-3", "onnx", "models/medium.onnx", 1500),
        JobSpec("job-4", "pth",  "models/large.pth",  6000),
    ]
    for j in test_cases:
        cfg = agent.decide_instance(j)
        print(f"  {j.model_type} | {j.model_size_mb:>6.0f} MB → {cfg.instance_type:<16} ({cfg.reason[:60]})")

    print("\n=== Active Jobs ===")
    jobs = agent.list_jobs()
    if jobs:
        for j in jobs:
            print(f"  {j}")
    else:
        print("  No active instances")
