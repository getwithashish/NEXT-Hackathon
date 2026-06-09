"""
DocReaderAgent — reads a provider's API documentation (via URL) and
extracts a RequestTemplate the worker can use to call that provider.

Flow:
  1. Fetch the doc page content via Exa (full text extraction)
  2. Send the content to Claude (Bedrock) with a structured prompt
  3. Claude returns a JSON RequestTemplate (request fields only — NO response_path needed)
  4. Validate by making one test call; response_path is auto-discovered during validation

Used by main.py BEFORE launching EC2 — runs on the backend server.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Optional

import boto3
import requests

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# RequestTemplate schema
# ---------------------------------------------------------------------------

class RequestTemplate:
    """
    Describes how to call a model provider's HTTP API.

    What the user (or DocReaderAgent) provides:
      url             — endpoint URL. Placeholders: {api_key}, {model}
      method          — HTTP method (default POST)
      headers         — dict of headers. {api_key} is substituted.
      body_template   — JSON body. Placeholders: {prompt}, {api_key}, {model}
      auth_type       — bearer | header | query_param | basic | aws_sigv4 | none
      query_params    — extra URL query params (non-auth)
      content_type    — body encoding (default: application/json)
      auth_param_name — (query_param) URL param name for key (default: "api_key")
      username        — (basic auth) username; api_key is the password
      aws_region      — (aws_sigv4) AWS region
      aws_service     — (aws_sigv4) AWS service name

    Auto-discovered (never required from user):
      response_path   — discovered automatically on first call
    """

    def __init__(
        self,
        url: str,
        method: str = "POST",
        headers: Optional[dict] = None,
        body_template: Optional[dict] = None,
        auth_type: str = "bearer",
        query_params: Optional[dict] = None,
        content_type: str = "application/json",
        auth_param_name: str = "api_key",
        username: str = "",
        aws_region: str = "",
        aws_service: str = "execute-api",
        response_path: str = "",   # auto-discovered; kept for backwards compat
        notes: str = "",
    ):
        self.url             = url
        self.method          = method.upper()
        self.headers         = headers or {"Content-Type": "application/json"}
        self.body_template   = body_template or {}
        self.auth_type       = auth_type.lower()
        self.query_params    = query_params or {}
        self.content_type    = content_type
        self.auth_param_name = auth_param_name
        self.username        = username
        self.aws_region      = aws_region or os.getenv("AWS_DEFAULT_REGION", "us-east-1")
        self.aws_service     = aws_service
        self.response_path   = response_path   # may be empty — will be discovered
        self.notes           = notes

    def to_dict(self) -> dict:
        return {
            "url":             self.url,
            "method":          self.method,
            "headers":         self.headers,
            "body_template":   self.body_template,
            "auth_type":       self.auth_type,
            "query_params":    self.query_params,
            "content_type":    self.content_type,
            "auth_param_name": self.auth_param_name,
            "username":        self.username,
            "aws_region":      self.aws_region,
            "aws_service":     self.aws_service,
            "response_path":   self.response_path,
            "notes":           self.notes,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "RequestTemplate":
        return cls(
            url             = d["url"],
            method          = d.get("method", "POST"),
            headers         = d.get("headers", {}),
            body_template   = d.get("body_template", {}),
            auth_type       = d.get("auth_type", "bearer"),
            query_params    = d.get("query_params", {}),
            content_type    = d.get("content_type", "application/json"),
            auth_param_name = d.get("auth_param_name", "api_key"),
            username        = d.get("username", ""),
            aws_region      = d.get("aws_region", ""),
            aws_service     = d.get("aws_service", "execute-api"),
            response_path   = d.get("response_path", ""),
            notes           = d.get("notes", ""),
        )


# ---------------------------------------------------------------------------
# DocReaderAgent
# ---------------------------------------------------------------------------

class DocReaderAgent:
    """
    Given a documentation URL for a model provider API, extracts a
    RequestTemplate using Exa (web fetch) + Claude (parsing).

    The user NEVER needs to specify response_path — it is auto-discovered
    during template validation via CustomTemplateCallerAgent.
    """

    EXTRACTION_PROMPT = """\
You are an API integration specialist. I will give you documentation text for an AI model provider.
Your task is to extract the exact information needed to make a chat/completion API call.

Return ONLY valid JSON matching this schema (no markdown, no explanation):
{{
  "url": "<full endpoint URL; use {{api_key}} or {{model}} as placeholders if they appear in the URL>",
  "method": "POST",
  "headers": {{
    "Content-Type": "application/json"
    // Add other required headers. Use {{api_key}} as placeholder for the key value.
    // Do NOT add Authorization here if auth_type is bearer, query_param, or basic —
    // it will be added automatically.
  }},
  "body_template": {{
    // Minimal JSON body for a single-turn chat/completion request.
    // Use {{prompt}} where the user message goes.
    // Use {{model}} where the model name/ID goes.
    // Keep other fields at documented defaults.
  }},
  "auth_type": "<one of: bearer | header | query_param | basic | aws_sigv4 | none>",
  // bearer     = Authorization: Bearer <key>  (most common, e.g. OpenAI, HuggingFace)
  // header     = custom header name (user puts it in headers dict above with {{api_key}})
  // query_param= key goes in URL query string (e.g. ?api_key=xxx)
  // basic      = HTTP Basic Auth (username + password)
  // aws_sigv4  = AWS Signature Version 4 (Bedrock, SageMaker, API Gateway)
  // none       = no authentication
  "query_params": {{}},  // extra NON-auth URL params if needed, e.g. {{"api-version": "2024-01"}}
  "content_type": "application/json",
  "auth_param_name": "api_key",  // only needed if auth_type is query_param; name of the key param
  "username": "",                // only needed if auth_type is basic
  "aws_region": "",              // only needed if auth_type is aws_sigv4
  "aws_service": "execute-api", // only needed if auth_type is aws_sigv4
  "notes": "<one sentence about quirks or required setup>"
}}

Do NOT include response_path — it will be discovered automatically.

Documentation:
{doc_text}
"""

    def __init__(self):
        self.bedrock  = boto3.client(
            "bedrock-runtime",
            region_name=os.getenv("AWS_DEFAULT_REGION", "us-east-1")
        )
        self.exa_key  = os.getenv("EXA_API_KEY", "")
        self.model_id = os.getenv(
            "DOC_READER_MODEL", "us.anthropic.claude-sonnet-4-20250514-v1:0"
        )

    # ── Exa fetch ─────────────────────────────────────────────────────────────────────

    def _fetch_doc(self, url: str) -> str:
        """
        Fetch documentation text from a URL.
        Tries Exa first (clean text extraction), falls back to plain HTTP GET.
        """
        if self.exa_key:
            try:
                resp = requests.post(
                    "https://api.exa.ai/contents",
                    headers={
                        "x-api-key": self.exa_key,
                        "Content-Type": "application/json",
                    },
                    json={"ids": [url], "text": True, "highlights": False},
                    timeout=20,
                )
                resp.raise_for_status()
                data = resp.json()
                results = data.get("results", [])
                if results and results[0].get("text"):
                    text = results[0]["text"]
                    log.info("Exa fetched %d chars from %s", len(text), url)
                    return text[:12000]
            except Exception as e:
                log.warning("Exa fetch failed (%s), falling back to HTTP", e)

        # Plain HTTP fallback
        resp = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        text = re.sub(r"<[^>]+>", " ", resp.text)
        text = re.sub(r"\s+", " ", text).strip()
        log.info("HTTP fetched %d chars from %s", len(text), url)
        return text[:12000]

    # ── Claude extraction ───────────────────────────────────────────────────────────

    def _extract_template(self, doc_text: str) -> dict:
        prompt = self.EXTRACTION_PROMPT.format(doc_text=doc_text)
        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": prompt}],
        })
        response = self.bedrock.invoke_model(
            modelId=self.model_id,
            body=body,
            contentType="application/json",
            accept="application/json",
        )
        raw = json.loads(response["body"].read())
        text = raw["content"][0]["text"].strip()
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
        # Strip JS-style comments before parsing
        text = re.sub(r"//[^\n]*", "", text)
        return json.loads(text)

    # ── Public API ───────────────────────────────────────────────────────────────────────────

    def extract_template_from_url(self, doc_url: str) -> RequestTemplate:
        """
        Main entry point. Fetches the doc page, parses with Claude,
        returns a RequestTemplate (without response_path — discovered later).
        """
        log.info("DocReaderAgent: reading %s", doc_url)
        doc_text = self._fetch_doc(doc_url)
        log.info("DocReaderAgent: %d chars → Claude", len(doc_text))
        template_dict = self._extract_template(doc_text)
        log.info("DocReaderAgent: extracted — url=%s auth_type=%s",
                 template_dict.get("url", "?"), template_dict.get("auth_type", "?"))
        return RequestTemplate.from_dict(template_dict)

    def validate_and_discover(
        self,
        template: RequestTemplate,
        api_key: str = "",
        model_hint: str = "",
        sample_prompt: str = "Reply with just the word: PING",
    ) -> tuple:
        """
        Validates the template with a real test call and auto-discovers response_path.
        Delegates to CustomTemplateCallerAgent so auth + discovery logic lives in one place.

        Returns (ok: bool, response_text_or_error: str, resolved_template_dict: dict).
        The resolved_template_dict always has response_path filled in — pass it to EC2.
        """
        # Import here to avoid circular dependency (both files import each other indirectly)
        agents_dir = str(Path(__file__).parent)
        if agents_dir not in sys.path:
            sys.path.insert(0, agents_dir)

        try:
            from api_caller_agent import CustomTemplateCallerAgent
        except ImportError:
            import importlib.util as _ilu
            spec = _ilu.spec_from_file_location(
                "api_caller_agent",
                Path(__file__).parent / "api_caller_agent.py"
            )
            mod = _ilu.module_from_spec(spec)
            spec.loader.exec_module(mod)
            CustomTemplateCallerAgent = mod.CustomTemplateCallerAgent

        caller = CustomTemplateCallerAgent(
            template.to_dict(), api_key=api_key, model_hint=model_hint
        )
        ok, text, resolved_dict = caller.validate(sample_prompt)
        # Sync back the discovered response_path into our template object
        if ok:
            template.response_path = resolved_dict.get("response_path", "")
        return ok, text, resolved_dict
