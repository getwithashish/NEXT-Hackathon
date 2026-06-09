#!/usr/bin/env python3
"""
fingerprint_worker.py — Model Fingerprinting Worker
====================================================
Runs as a standalone job (EC2 / local) or as an AWS Lambda function.
Credentials via IAM instance role / Lambda execution role (no hardcoded keys).

Supported model types:
  - api   : Behavioral fingerprinting — any provider via api_caller_agent

Required env vars (standalone):
  JOB_ID, MODEL_TYPE, AWS_S3_BUCKET, AWS_DEFAULT_REGION,
  BACKEND_URL, API_ENDPOINT, API_KEY

Lambda entry point: lambda_handler(event, context)
  event keys: job_id, model_type, api_endpoint, api_key, model_hint,
              backend_url, request_template, s3_bucket, region
"""

import os
import sys
import json
import time
import hashlib
import logging
import traceback
from collections import Counter
from pathlib import Path

from typing import Optional

import boto3
import numpy as np
import urllib.request
from botocore.exceptions import BotoCoreError, ClientError

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("fingerprint_worker")


# ---------------------------------------------------------------------------
# Configuration — read from environment
# ---------------------------------------------------------------------------
class Config:
    def __init__(self):
        self.job_id           = os.environ.get("JOB_ID", "unknown_job")
        self.model_type       = os.environ.get("MODEL_TYPE", "").lower().strip()
        self.s3_bucket        = os.environ.get("AWS_S3_BUCKET", "")
        self.region           = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
        self.api_endpoint     = os.environ.get("API_ENDPOINT", "")
        self.api_key          = os.environ.get("API_KEY", "")
        self.model_hint       = os.environ.get("MODEL_HINT", "")
        self.backend_url      = os.environ.get("BACKEND_URL", "http://54.86.179.209:8000")
        self.responses_s3_key = os.environ.get("RESPONSES_S3_KEY", "")
        # REQUEST_TEMPLATE: JSON string → parsed dict, or None if not set
        _rt = os.environ.get("REQUEST_TEMPLATE", "").strip()
        self.request_template: Optional[dict] = json.loads(_rt) if _rt and _rt != "{}" else None

    def validate(self):
        errors = []
        if not self.model_type:
            errors.append("MODEL_TYPE is required")
        if self.model_type not in ("api",):
            errors.append(f"MODEL_TYPE must be api, got: '{self.model_type}'")
        if not self.s3_bucket:
            errors.append("AWS_S3_BUCKET is required")
        return errors


# ---------------------------------------------------------------------------
# S3 helpers
# ---------------------------------------------------------------------------
def get_s3_client(region: str):
    return boto3.client("s3", region_name=region)


def upload_responses_to_s3(s3_client, bucket: str, key: str, responses: list) -> None:
    """Upload raw LLM response samples to S3 — only when payload is large."""
    payload = json.dumps(responses, indent=2, default=str).encode("utf-8")
    log.info("Offloading raw responses to s3://%s/%s (%d bytes)", bucket, key, len(payload))
    s3_client.put_object(Bucket=bucket, Key=key, Body=payload, ContentType="application/json")
    log.info("Raw responses offloaded.")


RAW_RESPONSE_THRESHOLD_KB = 5   # offload response_samples to S3 if larger than this


def post_result_to_backend(cfg: "Config", result: dict) -> None:
    """
    POST fingerprint result directly to the backend callback endpoint.
    Optionally strips large response_samples and offloads them to S3 first.
    """
    payload = dict(result)

    # Check if response_samples is big enough to offload
    responses_s3_key = None
    samples = payload.get("response_samples") or (
        (payload.get("behavioral_signature") or {}).get("response_samples")
    )
    if samples and cfg.responses_s3_key:
        samples_json = json.dumps(samples, default=str)
        if len(samples_json) > RAW_RESPONSE_THRESHOLD_KB * 1024:
            try:
                s3 = get_s3_client(cfg.region)
                upload_responses_to_s3(s3, cfg.s3_bucket, cfg.responses_s3_key, samples)
                if "response_samples" in payload:
                    del payload["response_samples"]
                if "behavioral_signature" in payload and "response_samples" in payload["behavioral_signature"]:
                    del payload["behavioral_signature"]["response_samples"]
                responses_s3_key = cfg.responses_s3_key
                log.info("Response samples offloaded to S3 (%d KB)", len(samples_json) // 1024)
            except Exception as e:
                log.warning("Failed to offload responses to S3 (sending inline): %s", e)

    callback_payload = {
        "status":           payload.get("status", "error"),
        "fingerprint_data": payload,
        "error":            payload.get("error"),
        "responses_s3_key": responses_s3_key,
    }

    url = f"{cfg.backend_url}/internal/job/{cfg.job_id}/complete"
    body = json.dumps(callback_payload, default=str).encode("utf-8")
    log.info("POSTing result to %s (%d bytes)", url, len(body))

    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        log.info("Backend callback: %s %s", resp.status, resp.read().decode())


# ---------------------------------------------------------------------------
# API / Behavioral fingerprinting — provider-agnostic via ApiCallerAgent
# ---------------------------------------------------------------------------

# Lazy import — api_caller_agent lives next to this file when deployed
import importlib.util as _ilu
import pathlib as _pl

def _load_caller_module():
    """Load api_caller_agent module from the scripts directory (co-located on EC2)."""
    here = _pl.Path(__file__).parent
    spec = _ilu.spec_from_file_location("api_caller_agent", here / "api_caller_agent.py")
    if spec is None or spec.loader is None:
        raise ImportError("Could not locate api_caller_agent.py next to fingerprint_worker.py")
    mod = _ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


DIVERSE_PROMPTS = [
    # Factual / knowledge
    "What is the speed of light in a vacuum?",
    "Explain the Pythagorean theorem in one sentence.",
    "Name the capital cities of France, Germany, and Japan.",
    "What year did the Berlin Wall fall?",
    "How many bones are in the adult human body?",
    # Reasoning / math
    "If a train travels 60 mph for 2.5 hours, how far does it go?",
    "What is the square root of 144?",
    "A rectangle has length 8 and width 5. What is its area?",
    "Which is larger: 7/8 or 5/6?",
    "If x + 3 = 10, what is x?",
    # Creative / open-ended
    "Write a one-sentence story about a robot who discovers music.",
    "Give me a haiku about the ocean.",
    "Describe the color blue to someone who has never seen it.",
    "Invent a name for a new planet and explain what it looks like.",
    "Write a one-line motto for a bakery.",
    # Language / reasoning
    "What is the opposite of 'ephemeral'?",
    "Give an example of an oxymoron.",
    "Translate 'hello, how are you?' into Spanish.",
    "What part of speech is the word 'quickly'?",
    "Complete this analogy: hot is to cold as fast is to ___.",
]


def _behavior_hash(responses: list[str]) -> str:
    """Deterministic hash over the concatenated responses."""
    combined = "\n---\n".join(responses)
    return hashlib.sha256(combined.encode("utf-8")).hexdigest()


def _top_vocabulary(responses: list[str], top_n: int = 20) -> list[dict]:
    """Return the top-N most frequent words across all responses."""
    words: list[str] = []
    for r in responses:
        words.extend(
            w.strip(".,!?;:\"'()[]{}").lower()
            for w in r.split()
            if len(w.strip(".,!?;:\"'()[]{}")) > 2
        )
    counter = Counter(words)
    return [{"word": w, "count": c} for w, c in counter.most_common(top_n)]


def fingerprint_api(cfg: Config) -> dict:
    """
    Behavioral fingerprint by probing the submitted API endpoint.

    Caller selection (in order):
      1. REQUEST_TEMPLATE env var set → CustomTemplateCallerAgent
         (user pre-defined the exact request format — most reliable)
      2. Neither → ApiCallerAgent heuristic + AI fallback
         (provider auto-detected from URL pattern)
    """
    if not cfg.api_endpoint:
        raise ValueError(
            "API_ENDPOINT is required for api-type fingerprinting. "
            "Provide the full URL of the LLM API to fingerprint."
        )

    mod = _load_caller_module()

    if cfg.request_template:
        log.info(
            "Using CustomTemplateCallerAgent | url=%s model_hint=%s",
            cfg.request_template.get("url", cfg.api_endpoint), cfg.model_hint or "(none)",
        )
        caller = mod.CustomTemplateCallerAgent(
            cfg.request_template,
            api_key=cfg.api_key,
            model_hint=cfg.model_hint or "",
        )
        # Validate once before firing all 20 probes
        # validate() returns (ok, text, resolved_template_dict) — unpack all 3
        ok, sample, _resolved = caller.validate()
        if not ok:
            raise RuntimeError(f"CustomTemplateCallerAgent validation failed: {sample}")
        log.info("Template validated. Sample: %s", sample[:120])
        batch_results = caller.call_batch(DIVERSE_PROMPTS)
        caller_type = "custom_template"
    else:
        log.info(
            "Using ApiCallerAgent (auto-detect) | endpoint=%s model_hint=%s",
            cfg.api_endpoint, cfg.model_hint or "(auto)",
        )
        caller = mod.ApiCallerAgent(cfg.api_endpoint, cfg.api_key, region=cfg.region)
        batch_results = caller.call_batch(DIVERSE_PROMPTS, model_hint=cfg.model_hint)
        caller_type = "auto"

    responses = [r["response"] for r in batch_results if not r["error"]]
    errors    = [{"prompt_index": i, "prompt": r["prompt"], "error": r["error"]}
                 for i, r in enumerate(batch_results) if r["error"]]
    latencies = [r["latency"] for r in batch_results if not r["error"]]

    if not responses:
        raise RuntimeError(
            f"All API calls failed — no responses collected.\n"
            f"First error: {errors[0]['error'] if errors else 'unknown'}"
        )

    lengths = [len(r) for r in responses]

    return {
        "fingerprint_type": "behavioral",
        "caller_type":      caller_type,
        "api_endpoint":     cfg.api_endpoint,
        "model_hint":       cfg.model_hint or "",
        "prompts_sent":     len(DIVERSE_PROMPTS),
        "responses_received": len(responses),
        "failed_invocations": len(errors),
        "errors": errors,
        "behavioral_signature": {
            "avg_response_length": float(np.mean(lengths)),
            "std_response_length": float(np.std(lengths)),
            "min_response_length": int(min(lengths)),
            "max_response_length": int(max(lengths)),
            "avg_latency_seconds": float(np.mean(latencies)) if latencies else None,
            "behavior_hash":   _behavior_hash(responses),
            "top_vocabulary":  _top_vocabulary(responses),
        },
        "response_samples": [r[:500] for r in responses],
    }


# ---------------------------------------------------------------------------
# Main worker orchestration
# ---------------------------------------------------------------------------
def run(cfg: Config) -> dict:
    """Run the appropriate fingerprinting strategy and return the result dict."""
    if cfg.model_type == "api":
        t0 = time.monotonic()
        fp_data = fingerprint_api(cfg)
        fp_data["fingerprint_duration_seconds"] = round(time.monotonic() - t0, 3)
    else:
        raise ValueError(f"Unsupported MODEL_TYPE: {cfg.model_type}")

    return fp_data


def main() -> int:
    cfg = Config()
    log.info(
        "=== Fingerprint Worker started | job=%s model_type=%s ===",
        cfg.job_id, cfg.model_type,
    )

    result: dict = {
        "job_id": cfg.job_id,
        "model_type": cfg.model_type,
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "unknown",
    }

    # Validate config
    errors = cfg.validate()
    if errors:
        msg = "Config validation failed: " + "; ".join(errors)
        log.error(msg)
        result["status"] = "config_error"
        result["error"] = msg
        # Still attempt to callback with the config error
        if cfg.backend_url and cfg.job_id:
            try:
                post_result_to_backend(cfg, result)
            except Exception as upload_exc:  # noqa: BLE001
                log.error("Failed to send error result to backend: %s", upload_exc)
        return 1

    try:
        fp_data = run(cfg)
        result.update(fp_data)
        result["status"] = "success"
        log.info("Fingerprinting completed successfully.")
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        log.error("Fingerprinting failed:\n%s", tb)
        result["status"] = "error"
        result["error"] = str(exc)
        result["traceback"] = tb

    # Always POST result to backend (direct callback — no S3 polling)
    try:
        post_result_to_backend(cfg, result)
    except Exception as cb_exc:  # noqa: BLE001
        log.error(
            "CRITICAL: Failed to POST result to backend (%s): %s",
            cfg.backend_url, cb_exc,
        )
        print("RESULT_FALLBACK:", json.dumps(result, default=str))
        return 2

    exit_code = 0 if result["status"] == "success" else 1
    log.info("=== Worker finished | status=%s exit=%d ===", result["status"], exit_code)
    return exit_code


# ---------------------------------------------------------------------------
# Lambda entry point
# ---------------------------------------------------------------------------
def lambda_handler(event: dict, context) -> dict:
    """
    Lambda entry point. Event fields (all strings unless noted):
      job_id, model_type, api_endpoint, api_key, model_hint,
      backend_url, request_template (JSON string or None),
      s3_bucket, region
    """
    # populate os.environ from event so Config() picks everything up
    mapping = {
        'JOB_ID':               event.get('job_id', ''),
        'MODEL_TYPE':           event.get('model_type', 'api'),
        'API_ENDPOINT':         event.get('api_endpoint', ''),
        'API_KEY':              event.get('api_key', ''),
        'MODEL_HINT':           event.get('model_hint', ''),
        'BACKEND_URL':          event.get('backend_url', ''),
        'REQUEST_TEMPLATE':     event.get('request_template', ''),
        'AWS_S3_BUCKET':        event.get('s3_bucket', ''),
        'AWS_DEFAULT_REGION':   event.get('region', 'us-east-1'),
    }
    for k, v in mapping.items():
        if v:
            os.environ[k] = str(v)
    exit_code = main()
    return {'statusCode': 200 if exit_code == 0 else 500, 'exit_code': exit_code}


if __name__ == '__main__':
    sys.exit(main())
