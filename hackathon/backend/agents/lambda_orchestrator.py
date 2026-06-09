"""
lambda_orchestrator.py — replaces ec2_orchestrator_agent.
Invokes the fingerprint-worker Lambda function asynchronously.
The Lambda function POSTs results back to /internal/job/{job_id}/complete.
"""
import boto3
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Optional

log = logging.getLogger(__name__)

LAMBDA_FUNCTION_NAME = os.getenv("LAMBDA_FUNCTION_NAME", "fingerprint-worker")
BACKEND_URL          = os.getenv("BACKEND_URL", "http://54.86.179.209:8000")
AWS_REGION           = os.getenv("AWS_REGION", "us-east-1")
S3_BUCKET            = os.getenv("AWS_S3_BUCKET", "model-fingerprint-verify-models-1780978543")


@dataclass
class JobSpec:
    job_id:           str
    model_type:       str          # always "api" for now
    api_endpoint:     Optional[str] = None
    api_key:          Optional[str] = None
    model_hint:       Optional[str] = ""
    request_template: Optional[dict] = None
    # weight-based fields reserved for future use
    s3_model_key:     Optional[str] = None
    model_size_mb:    float = 0.0


class LambdaOrchestratorAgent:
    def __init__(self):
        pass  # client created fresh per call so IAM changes take effect immediately

    def launch(self, job: JobSpec) -> dict:
        # Fresh client each time — picks up latest IAM credentials from IMDS
        self.client = boto3.client("lambda", region_name=AWS_REGION)
        """
        Invoke the Lambda function asynchronously (Event invocation type).
        Returns immediately — Lambda will POST the result back to the backend.
        """
        payload = {
            "job_id":           job.job_id,
            "model_type":       job.model_type,
            "api_endpoint":     job.api_endpoint or "",
            "api_key":          job.api_key or "",
            "model_hint":       job.model_hint or "",
            "backend_url":      BACKEND_URL,
            "s3_bucket":        S3_BUCKET,
            "region":           AWS_REGION,
            "request_template": json.dumps(job.request_template) if job.request_template else "",
        }
        log.info("Invoking Lambda %s async | job=%s endpoint=%s",
                 LAMBDA_FUNCTION_NAME, job.job_id, job.api_endpoint)
        resp = self.client.invoke(
            FunctionName   = LAMBDA_FUNCTION_NAME,
            InvocationType = "Event",          # async — returns 202 immediately
            Payload        = json.dumps(payload).encode(),
        )
        status = resp["StatusCode"]
        if status != 202:
            raise RuntimeError(f"Lambda invoke returned unexpected status {status}")
        log.info("Lambda invoked OK | job=%s status=%s", job.job_id, status)
        return {"status": "invoked", "job_id": job.job_id, "lambda_status_code": status}
