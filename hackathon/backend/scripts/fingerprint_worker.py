#!/usr/bin/env python3
"""
fingerprint_worker.py — Model Fingerprinting Worker for AWS EC2
================================================================
Runs as a standalone job on Amazon Linux 2 DLAMI.
Credentials via IAM instance role (no hardcoded keys).

Supported model types:
  - pth   : PyTorch weight-based fingerprinting (layer stats + SHA256)
  - onnx  : ONNX graph/weight fingerprinting
  - api   : Behavioral fingerprinting via AWS Bedrock (Claude Haiku)

Required env vars:
  JOB_ID, MODEL_TYPE, S3_MODEL_KEY, RESULT_S3_KEY,
  AWS_S3_BUCKET, AWS_DEFAULT_REGION, API_ENDPOINT, API_KEY
"""

import os
import sys
import json
import time
import hashlib
import logging
import tempfile
import traceback
from collections import Counter
from pathlib import Path

import boto3
import numpy as np
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
        self.job_id         = os.environ.get("JOB_ID", "unknown_job")
        self.model_type     = os.environ.get("MODEL_TYPE", "").lower().strip()
        self.s3_model_key   = os.environ.get("S3_MODEL_KEY", "")
        self.result_s3_key  = os.environ.get("RESULT_S3_KEY", "")
        self.s3_bucket      = os.environ.get("AWS_S3_BUCKET", "")
        self.region         = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
        self.api_endpoint   = os.environ.get("API_ENDPOINT", "")
        self.api_key        = os.environ.get("API_KEY", "")

    def validate(self):
        errors = []
        if not self.model_type:
            errors.append("MODEL_TYPE is required")
        if self.model_type not in ("pth", "onnx", "api"):
            errors.append(f"MODEL_TYPE must be pth/onnx/api, got: '{self.model_type}'")
        if not self.result_s3_key:
            errors.append("RESULT_S3_KEY is required")
        if not self.s3_bucket:
            errors.append("AWS_S3_BUCKET is required")
        if self.model_type in ("pth", "onnx") and not self.s3_model_key:
            errors.append("S3_MODEL_KEY is required for pth/onnx model types")
        return errors


# ---------------------------------------------------------------------------
# S3 helpers
# ---------------------------------------------------------------------------
def get_s3_client(region: str):
    return boto3.client("s3", region_name=region)


def download_from_s3(s3_client, bucket: str, key: str, local_path: str) -> None:
    log.info("Downloading s3://%s/%s → %s", bucket, key, local_path)
    s3_client.download_file(bucket, key, local_path)
    size = Path(local_path).stat().st_size
    log.info("Download complete: %.2f MB", size / 1_048_576)


def upload_result_to_s3(s3_client, bucket: str, key: str, result: dict) -> None:
    payload = json.dumps(result, indent=2, default=str).encode("utf-8")
    log.info("Uploading result to s3://%s/%s (%d bytes)", bucket, key, len(payload))
    s3_client.put_object(
        Bucket=bucket,
        Key=key,
        Body=payload,
        ContentType="application/json",
    )
    log.info("Result upload complete.")


# ---------------------------------------------------------------------------
# PTH fingerprinting (torch imported lazily)
# ---------------------------------------------------------------------------
def _sha256_of_bytes(data: bytes) -> str:
    h = hashlib.sha256()
    h.update(data)
    return h.hexdigest()


def _tensor_stats(tensor) -> dict:
    """Return descriptive statistics for a single weight tensor."""
    try:
        arr = tensor.detach().float().cpu().numpy().astype(np.float64)
        flat = arr.flatten()
        return {
            "shape": list(tensor.shape),
            "dtype": str(tensor.dtype),
            "numel": int(flat.size),
            "mean": float(np.mean(flat)),
            "std": float(np.std(flat)),
            "min": float(np.min(flat)),
            "max": float(np.max(flat)),
            "l2_norm": float(np.linalg.norm(flat)),
            "sha256": _sha256_of_bytes(flat.tobytes()),
        }
    except Exception as exc:
        return {"error": str(exc)}


def fingerprint_pth(local_path: str) -> dict:
    """Weight-based fingerprint for a PyTorch .pth checkpoint."""
    # Lazy import — torch must NOT be imported at module level
    import torch  # noqa: PLC0415

    log.info("Loading PyTorch checkpoint: %s", local_path)
    try:
        checkpoint = torch.load(
            local_path,
            map_location="cpu",
            weights_only=True,   # safe loading — no arbitrary code execution
        )
    except TypeError:
        # older torch versions don't support weights_only
        checkpoint = torch.load(local_path, map_location="cpu")

    # Normalise to state_dict
    if isinstance(checkpoint, dict):
        if "state_dict" in checkpoint:
            state_dict = checkpoint["state_dict"]
            meta = {k: str(v) for k, v in checkpoint.items() if k != "state_dict"}
        elif all(hasattr(v, "shape") for v in checkpoint.values()):
            state_dict = checkpoint
            meta = {}
        else:
            state_dict = checkpoint
            meta = {}
    else:
        # nn.Module saved directly
        try:
            state_dict = checkpoint.state_dict()
            meta = {"class": type(checkpoint).__name__}
        except AttributeError:
            raise ValueError(f"Unrecognised checkpoint format: {type(checkpoint)}")

    log.info("State dict has %d tensors", len(state_dict))

    # Per-layer stats
    layer_stats = {}
    sha256_accumulator = hashlib.sha256()
    total_params = 0

    for name, tensor in state_dict.items():
        stats = _tensor_stats(tensor)
        layer_stats[name] = stats
        total_params += stats.get("numel", 0)
        # Feed layer SHA into global hash for a composite fingerprint
        sha256_accumulator.update(stats.get("sha256", name).encode())

    # Global weight hash — deterministic across identical weights regardless of filename
    global_sha256 = sha256_accumulator.hexdigest()

    # Aggregate stats across all layers (float tensors only)
    all_means = [v["mean"] for v in layer_stats.values() if "mean" in v]
    all_stds  = [v["std"]  for v in layer_stats.values() if "std"  in v]

    aggregate = {
        "layer_count": len(state_dict),
        "total_params": total_params,
        "mean_of_means": float(np.mean(all_means)) if all_means else None,
        "std_of_means":  float(np.std(all_means))  if all_means else None,
        "mean_of_stds":  float(np.mean(all_stds))  if all_stds  else None,
    }

    return {
        "fingerprint_type": "weight_based",
        "global_sha256": global_sha256,
        "aggregate_stats": aggregate,
        "layer_stats": layer_stats,
        "checkpoint_meta": meta,
        "torch_version": torch.__version__,
    }


# ---------------------------------------------------------------------------
# ONNX fingerprinting
# ---------------------------------------------------------------------------
def _onnx_initializer_stats(initializer) -> dict:
    """Return stats for an ONNX initializer (weight tensor)."""
    try:
        import onnx.numpy_helper as nph  # noqa: PLC0415
        arr = nph.to_array(initializer).astype(np.float64).flatten()
        return {
            "name": initializer.name,
            "dims": list(initializer.dims),
            "data_type": initializer.data_type,
            "numel": int(arr.size),
            "mean": float(np.mean(arr)),
            "std": float(np.std(arr)),
            "min": float(np.min(arr)),
            "max": float(np.max(arr)),
            "l2_norm": float(np.linalg.norm(arr)),
            "sha256": _sha256_of_bytes(arr.tobytes()),
        }
    except Exception as exc:
        return {"name": initializer.name, "error": str(exc)}


def fingerprint_onnx(local_path: str) -> dict:
    """Weight-based fingerprint for an ONNX model file."""
    import onnx  # noqa: PLC0415

    log.info("Loading ONNX model: %s", local_path)
    model = onnx.load(local_path)
    onnx.checker.check_model(model)

    graph = model.graph
    log.info(
        "ONNX graph: %d nodes, %d initializers",
        len(graph.node),
        len(graph.initializer),
    )

    # Graph topology hash
    node_ops = [n.op_type for n in graph.node]
    topo_str = "|".join(node_ops)
    topology_hash = hashlib.sha256(topo_str.encode()).hexdigest()

    # Initializer (weight) stats
    sha256_accumulator = hashlib.sha256()
    weight_stats = {}
    total_params = 0

    for init in graph.initializer:
        stats = _onnx_initializer_stats(init)
        weight_stats[init.name] = stats
        total_params += stats.get("numel", 0)
        sha256_accumulator.update(stats.get("sha256", init.name).encode())

    global_sha256 = sha256_accumulator.hexdigest()

    all_means = [v["mean"] for v in weight_stats.values() if "mean" in v]
    all_stds  = [v["std"]  for v in weight_stats.values() if "std"  in v]

    opset_versions = [op.version for op in model.opset_import]

    return {
        "fingerprint_type": "weight_based",
        "global_sha256": global_sha256,
        "topology_hash": topology_hash,
        "aggregate_stats": {
            "initializer_count": len(graph.initializer),
            "node_count": len(graph.node),
            "total_params": total_params,
            "mean_of_means": float(np.mean(all_means)) if all_means else None,
            "std_of_means":  float(np.std(all_means))  if all_means else None,
            "mean_of_stds":  float(np.mean(all_stds))  if all_stds  else None,
        },
        "weight_stats": weight_stats,
        "model_ir_version": model.ir_version,
        "opset_versions": opset_versions,
        "onnx_version": onnx.__version__,
    }


# ---------------------------------------------------------------------------
# API / Behavioral fingerprinting via AWS Bedrock
# ---------------------------------------------------------------------------
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

BEDROCK_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"


def _invoke_bedrock(bedrock_client, prompt: str, max_tokens: int = 256) -> str:
    """Invoke a Bedrock model and return the text response."""
    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    })
    response = bedrock_client.invoke_model(
        modelId=BEDROCK_MODEL_ID,
        body=body,
        contentType="application/json",
        accept="application/json",
    )
    response_body = json.loads(response["body"].read())
    # Claude response format: content[0].text
    return response_body["content"][0]["text"]


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
    """Behavioral fingerprint via AWS Bedrock (no Anthropic SDK)."""
    log.info(
        "Starting behavioral fingerprinting via Bedrock model %s",
        BEDROCK_MODEL_ID,
    )
    bedrock = boto3.client("bedrock-runtime", region_name=cfg.region)

    responses: list[str] = []
    errors: list[dict] = []
    latencies: list[float] = []

    for i, prompt in enumerate(DIVERSE_PROMPTS):
        log.info("Prompt %02d/%02d: %s…", i + 1, len(DIVERSE_PROMPTS), prompt[:60])
        t0 = time.monotonic()
        try:
            text = _invoke_bedrock(bedrock, prompt)
            latency = time.monotonic() - t0
            responses.append(text)
            latencies.append(latency)
            log.info("  → %d chars in %.2fs", len(text), latency)
        except (BotoCoreError, ClientError) as exc:
            latency = time.monotonic() - t0
            log.warning("  Bedrock error on prompt %d: %s", i + 1, exc)
            errors.append({"prompt_index": i, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            latency = time.monotonic() - t0
            log.warning("  Unexpected error on prompt %d: %s", i + 1, exc)
            errors.append({"prompt_index": i, "error": str(exc)})

    if not responses:
        raise RuntimeError("All Bedrock invocations failed — no responses collected.")

    lengths = [len(r) for r in responses]
    avg_len = float(np.mean(lengths))
    std_len = float(np.std(lengths))
    avg_latency = float(np.mean(latencies)) if latencies else None

    b_hash = _behavior_hash(responses)
    vocab  = _top_vocabulary(responses)

    return {
        "fingerprint_type": "behavioral",
        "bedrock_model_id": BEDROCK_MODEL_ID,
        "prompts_sent": len(DIVERSE_PROMPTS),
        "responses_received": len(responses),
        "failed_invocations": len(errors),
        "errors": errors,
        "behavioral_signature": {
            "avg_response_length": avg_len,
            "std_response_length": std_len,
            "min_response_length": int(min(lengths)),
            "max_response_length": int(max(lengths)),
            "avg_latency_seconds": avg_latency,
            "behavior_hash": b_hash,
            "top_vocabulary": vocab,
        },
        # Store raw responses for offline analysis (truncated to 500 chars each)
        "response_samples": [r[:500] for r in responses],
    }


# ---------------------------------------------------------------------------
# Main worker orchestration
# ---------------------------------------------------------------------------
def run(cfg: Config) -> dict:
    """Run the appropriate fingerprinting strategy and return the result dict."""
    s3 = get_s3_client(cfg.region)

    if cfg.model_type in ("pth", "onnx"):
        # Download model file to a temp directory
        suffix = f".{cfg.model_type}"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            local_path = tmp.name

        try:
            download_from_s3(s3, cfg.s3_bucket, cfg.s3_model_key, local_path)
            file_size = Path(local_path).stat().st_size

            t0 = time.monotonic()
            if cfg.model_type == "pth":
                fp_data = fingerprint_pth(local_path)
            else:
                fp_data = fingerprint_onnx(local_path)
            elapsed = time.monotonic() - t0

            fp_data["file_size_bytes"] = file_size
            fp_data["fingerprint_duration_seconds"] = round(elapsed, 3)
        finally:
            try:
                os.unlink(local_path)
            except OSError:
                pass

    elif cfg.model_type == "api":
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
        "s3_model_key": cfg.s3_model_key,
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
        # Still attempt to upload if we have enough to do so
        if cfg.s3_bucket and cfg.result_s3_key:
            try:
                s3 = get_s3_client(cfg.region)
                upload_result_to_s3(s3, cfg.s3_bucket, cfg.result_s3_key, result)
            except Exception as upload_exc:  # noqa: BLE001
                log.error("Failed to upload error result: %s", upload_exc)
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

    # Always upload result
    try:
        s3 = get_s3_client(cfg.region)
        upload_result_to_s3(s3, cfg.s3_bucket, cfg.result_s3_key, result)
    except Exception as upload_exc:  # noqa: BLE001
        log.error(
            "CRITICAL: Failed to upload result to S3 (s3://%s/%s): %s",
            cfg.s3_bucket, cfg.result_s3_key, upload_exc,
        )
        # Print to stdout as last resort so CloudWatch can capture it
        print("RESULT_FALLBACK:", json.dumps(result, default=str))
        return 2

    exit_code = 0 if result["status"] == "success" else 1
    log.info("=== Worker finished | status=%s exit=%d ===", result["status"], exit_code)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
