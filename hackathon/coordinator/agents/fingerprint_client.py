"""
Client for the fingerprinting backend API.
"""

import time
from typing import Any, Optional
import requests


class FingerprintClient:
    def __init__(self, backend_url: str = "http://54.86.179.209:8000"):
        self.backend_url = backend_url.rstrip("/")

    def submit_job(
        self,
        provider_name: str,
        api_endpoint: str,
        api_key: str,
        model_name: str,
        model_hint: str = "",
        request_template: Optional[dict] = None,
    ) -> str:
        """
        Submit a fingerprinting job to the backend.

        Returns the job_id string.
        Raises on non-200 response.
        """
        body: dict[str, Any] = {
            "api_endpoint": api_endpoint,
            "api_key": api_key,
            "model_name": model_name,
            "model_hint": model_hint,
        }
        if request_template is not None:
            body["request_template"] = request_template

        response = requests.post(f"{self.backend_url}/fingerprint/api", json=body)
        response.raise_for_status()
        data = response.json()
        return data["job_id"]

    def poll_job(
        self,
        job_id: str,
        timeout_seconds: int = 300,
        poll_interval: int = 10,
    ) -> dict:
        """
        Poll the backend for job status until it is 'done' or 'error'.

        Returns the full job dict.
        Raises TimeoutError if the job does not complete within timeout_seconds.
        """
        deadline = time.monotonic() + timeout_seconds

        while True:
            response = requests.get(f"{self.backend_url}/job/{job_id}")
            response.raise_for_status()
            job = response.json()

            if job.get("status") in ("done", "error"):
                return job

            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Job {job_id!r} did not complete within {timeout_seconds}s "
                    f"(last status: {job.get('status')!r})"
                )

            time.sleep(poll_interval)

    def get_models(self) -> list[dict]:
        """
        Retrieve the list of known model dicts from the backend.
        """
        response = requests.get(f"{self.backend_url}/models")
        response.raise_for_status()
        return response.json()
