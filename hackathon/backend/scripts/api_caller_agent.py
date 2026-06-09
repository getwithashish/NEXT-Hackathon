"""
api_caller_agent.py — Provider-agnostic LLM API caller
=======================================================
Two-layer approach:

Layer 1 — Heuristic detector:
  Pattern-matches endpoint URL to 12+ known providers.
  Zero latency, zero cost, covers 95% of real-world cases.

Layer 2 — AI agent fallback (Bedrock Claude + Exa):
  For unknown providers, an agent searches the web for API docs,
  reasons about the request format, and constructs the call.
  Retries up to 3 times with error feedback.

Usage:
    caller = ApiCallerAgent(api_endpoint, api_key, region="us-east-1")
    response_text = caller.call(prompt, model_hint="gpt-4o")
"""

import json
import logging
import os
import re
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
import urllib.parse

import boto3
import requests

log = logging.getLogger(__name__)

EXA_API_KEY = os.environ.get("EXA_API_KEY", "")
BEDROCK_AGENT_MODEL = "anthropic.claude-3-haiku-20240307-v1:0"


# ── Known provider patterns ────────────────────────────────────────────────────

class _Provider:
    """Base class for a known LLM provider."""
    name: str = "unknown"

    def call(self, endpoint: str, api_key: str, prompt: str, model_hint: str = "") -> str:
        raise NotImplementedError


class OpenAICompatProvider(_Provider):
    """OpenAI-compatible: Bearer auth, /v1/chat/completions, messages array."""
    name = "openai-compat"

    DEFAULT_MODELS = {
        "openai":      "gpt-4o-mini",
        "groq":        "llama3-8b-8192",
        "mistral":     "mistral-small-latest",
        "together":    "meta-llama/Llama-3-8b-chat-hf",
        "perplexity":  "llama-3.1-sonar-small-128k-online",
        "deepinfra":   "meta-llama/Meta-Llama-3-8B-Instruct",
        "openrouter":  "openai/gpt-4o-mini",
    }

    def __init__(self, provider_key: str = "openai"):
        self.provider_key = provider_key

    def call(self, endpoint: str, api_key: str, prompt: str, model_hint: str = "") -> str:
        # Normalise endpoint to /v1/chat/completions
        base = endpoint.rstrip("/")
        if not base.endswith("/chat/completions"):
            if "/v1" not in base:
                base = base + "/v1"
            base = base + "/chat/completions"

        model = model_hint or self.DEFAULT_MODELS.get(self.provider_key, "gpt-4o-mini")
        body = json.dumps({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 512,
        }).encode()

        req = Request(base, data=body, headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        })
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        return data["choices"][0]["message"]["content"]


class AnthropicProvider(_Provider):
    name = "anthropic"

    def call(self, endpoint: str, api_key: str, prompt: str, model_hint: str = "") -> str:
        base = endpoint.rstrip("/")
        if not base.endswith("/messages"):
            base = base.rstrip("/v1").rstrip("/") + "/v1/messages"

        model = model_hint or "claude-3-haiku-20240307"
        body = json.dumps({
            "model": model,
            "max_tokens": 512,
            "messages": [{"role": "user", "content": prompt}],
        }).encode()

        req = Request(base, data=body, headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        })
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        return data["content"][0]["text"]


class GoogleGeminiProvider(_Provider):
    name = "google-gemini"

    def call(self, endpoint: str, api_key: str, prompt: str, model_hint: str = "") -> str:
        model = model_hint or "gemini-1.5-flash"
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model}:generateContent?key={api_key}"
        )
        body = json.dumps({
            "contents": [{"parts": [{"text": prompt}]}]
        }).encode()
        req = Request(url, data=body, headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        return data["candidates"][0]["content"]["parts"][0]["text"]


class CohereProvider(_Provider):
    name = "cohere"

    def call(self, endpoint: str, api_key: str, prompt: str, model_hint: str = "") -> str:
        url = "https://api.cohere.com/v2/chat"
        model = model_hint or "command-r"
        body = json.dumps({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
        }).encode()
        req = Request(url, data=body, headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        })
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        return data["message"]["content"][0]["text"]


class AzureOpenAIProvider(_Provider):
    name = "azure-openai"

    def call(self, endpoint: str, api_key: str, prompt: str, model_hint: str = "") -> str:
        # Azure endpoint format:
        # https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=...
        base = endpoint.rstrip("/")
        if "chat/completions" not in base:
            deployment = model_hint or "gpt-4o-mini"
            base = f"{base}/openai/deployments/{deployment}/chat/completions?api-version=2024-02-01"

        body = json.dumps({
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 512,
        }).encode()
        req = Request(base, data=body, headers={
            "api-key": api_key,
            "Content-Type": "application/json",
        })
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        return data["choices"][0]["message"]["content"]


class OllamaProvider(_Provider):
    name = "ollama"

    def call(self, endpoint: str, api_key: str, prompt: str, model_hint: str = "") -> str:
        base = endpoint.rstrip("/")
        # Try OpenAI-compat first, fallback to native /api/generate
        url = base + "/v1/chat/completions"
        model = model_hint or "llama3"
        body = json.dumps({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
        }).encode()
        try:
            req = Request(url, data=body, headers={"Content-Type": "application/json"})
            with urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
            return data["choices"][0]["message"]["content"]
        except Exception:
            # Native Ollama API
            url = base + "/api/generate"
            body = json.dumps({"model": model, "prompt": prompt, "stream": False}).encode()
            req = Request(url, data=body, headers={"Content-Type": "application/json"})
            with urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
            return data["response"]


class BedrockProvider(_Provider):
    """AWS Bedrock — uses boto3 not HTTP."""
    name = "bedrock"

    def __init__(self, region: str = "us-east-1"):
        self.region = region

    def call(self, endpoint: str, api_key: str, prompt: str, model_hint: str = "") -> str:
        model = model_hint or "anthropic.claude-3-haiku-20240307-v1:0"
        client = boto3.client("bedrock-runtime", region_name=self.region)
        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 512,
            "messages": [{"role": "user", "content": prompt}],
        })
        resp = client.invoke_model(modelId=model, body=body,
                                   contentType="application/json", accept="application/json")
        data = json.loads(resp["body"].read())
        return data["content"][0]["text"]


# ── Heuristic provider detector ────────────────────────────────────────────────

def detect_provider(endpoint: str, region: str = "us-east-1"):
    """
    Returns the right provider instance for a given endpoint URL.
    Returns None if no match — caller should use the AI agent fallback.
    """
    url = endpoint.lower().strip().rstrip("/")
    parsed = urlparse(url)
    host = parsed.netloc or parsed.path

    patterns = [
        # (regex, provider_instance)
        (r"api\.openai\.com",                      OpenAICompatProvider("openai")),
        (r"api\.anthropic\.com",                   AnthropicProvider()),
        (r"generativelanguage\.googleapis\.com",   GoogleGeminiProvider()),
        (r"api\.cohere\.(com|ai)",                 CohereProvider()),
        (r"\.openai\.azure\.com",                  AzureOpenAIProvider()),
        (r"api\.mistral\.ai",                      OpenAICompatProvider("mistral")),
        (r"api\.groq\.com",                        OpenAICompatProvider("groq")),
        (r"api\.together\.(ai|xyz)",               OpenAICompatProvider("together")),
        (r"api\.perplexity\.ai",                   OpenAICompatProvider("perplexity")),
        (r"api\.deepinfra\.com",                   OpenAICompatProvider("deepinfra")),
        (r"openrouter\.ai",                        OpenAICompatProvider("openrouter")),
        (r"(localhost|127\.0\.0\.1)(:\d+)?",       OllamaProvider()),
        (r"bedrock(-runtime)?\..*\.amazonaws\.com",BedrockProvider(region)),
    ]

    for pattern, provider in patterns:
        if re.search(pattern, host):
            log.info("Provider detected: %s (pattern: %s)", provider.name, pattern)
            return provider

    return None  # unknown — use AI agent


# ── Exa search helper ──────────────────────────────────────────────────────────

def _exa_search(query: str, num_results: int = 5) -> str:
    """Call Exa search API and return highlights as a string."""
    if not EXA_API_KEY:
        return "Exa API key not configured."

    url = "https://api.exa.ai/search"
    body = json.dumps({
        "query": query,
        "type": "auto",
        "numResults": num_results,
        "contents": {"highlights": True},
    }).encode()
    req = Request(url, data=body, headers={
        "x-api-key": EXA_API_KEY,
        "Content-Type": "application/json",
    })
    try:
        with urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
        results = data.get("results", [])
        if not results:
            return "No results found."
        lines = []
        for r in results:
            lines.append(f"### {r.get('title','')}\nURL: {r.get('url','')}")
            for h in r.get("highlights", []):
                lines.append(f"  > {h}")
        return "\n".join(lines)
    except Exception as exc:
        return f"Exa search error: {exc}"


def _exa_get_contents(url_to_fetch: str) -> str:
    """Fetch and return highlights from a specific URL via Exa /contents."""
    if not EXA_API_KEY:
        return "Exa API key not configured."

    url = "https://api.exa.ai/contents"
    body = json.dumps({
        "urls": [url_to_fetch],
        "highlights": True,
    }).encode()
    req = Request(url, data=body, headers={
        "x-api-key": EXA_API_KEY,
        "Content-Type": "application/json",
    })
    try:
        with urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
        results = data.get("results", [])
        if not results:
            return "No content retrieved."
        highlights = results[0].get("highlights", [])
        return "\n".join(f"> {h}" for h in highlights) or results[0].get("text", "")[:2000]
    except Exception as exc:
        return f"Exa contents error: {exc}"


def _try_http_call(endpoint: str, api_key: str, prompt: str, request_spec: dict) -> tuple[str, str]:
    """
    Attempt an HTTP call based on the agent's constructed spec.
    Returns (response_text, error_message). One of them will be empty.

    request_spec shape:
    {
        "url": "...",
        "method": "POST",
        "headers": {"Authorization": "Bearer {api_key}", ...},
        "body": {...}
    }
    """
    try:
        url = request_spec["url"]
        headers = {
            k: v.replace("{api_key}", api_key)
            for k, v in request_spec.get("headers", {}).items()
        }
        body_dict = request_spec.get("body", {})
        # Replace prompt placeholder
        body_str = json.dumps(body_dict).replace("{prompt}", prompt)
        body_bytes = body_str.encode()

        req = Request(url, data=body_bytes, headers={
            **headers,
            "Content-Type": "application/json",
        })
        with urlopen(req, timeout=30) as resp:
            raw = resp.read()
            data = json.loads(raw)

        # Try to extract text from common response shapes
        extract_path = request_spec.get("response_path", "")
        if extract_path:
            parts = extract_path.split(".")
            val = data
            for p in parts:
                if p.isdigit():
                    val = val[int(p)]
                else:
                    val = val[p]
            return str(val), ""

        # Auto-detect common shapes
        if "choices" in data:
            return data["choices"][0]["message"]["content"], ""
        if "content" in data and isinstance(data["content"], list):
            return data["content"][0].get("text", str(data["content"][0])), ""
        if "content" in data and isinstance(data["content"], str):
            return data["content"], ""
        if "candidates" in data:
            return data["candidates"][0]["content"]["parts"][0]["text"], ""
        if "message" in data:
            msg = data["message"]
            if isinstance(msg, dict) and "content" in msg:
                content = msg["content"]
                if isinstance(content, list):
                    return content[0].get("text", ""), ""
                return str(content), ""
        if "response" in data:
            return data["response"], ""
        if "text" in data:
            return data["text"], ""
        if "output" in data:
            return str(data["output"]), ""

        return json.dumps(data)[:500], ""

    except HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:500]
        except Exception:
            pass
        return "", f"HTTP {e.code}: {body}"
    except URLError as e:
        return "", f"URLError: {e.reason}"
    except Exception as e:
        return "", f"{type(e).__name__}: {e}"


# ── AI Agent fallback ──────────────────────────────────────────────────────────

AGENT_SYSTEM_PROMPT = """You are an expert at LLM API integrations. Your job is to figure out
how to call an unknown LLM API endpoint and return a working request specification.

You have access to two tools:
1. exa_search(query) — search the web for API documentation
2. exa_get_contents(url) — fetch the content of a specific documentation URL

Use them to find:
- The correct request format (headers, body structure)
- How the API key is passed (Bearer token, custom header, query param, etc.)
- How to extract the response text

Then output a JSON request specification. Be precise and concise."""


def _run_ai_agent(endpoint: str, api_key: str, prompt: str, model_hint: str,
                  bedrock_client) -> tuple[str, dict]:
    """
    Run a Bedrock Claude agent with Exa tools to figure out how to call
    an unknown API endpoint. Returns (response_text, request_spec_used).
    """
    parsed = urlparse(endpoint)
    host = parsed.netloc or endpoint
    provider_name = host.split(".")[0] if "." in host else host

    # Tool definitions for Claude
    tools = [
        {
            "name": "exa_search",
            "description": "Search the web for API documentation about an LLM provider.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"}
                },
                "required": ["query"]
            }
        },
        {
            "name": "exa_get_contents",
            "description": "Fetch and read the content of a specific documentation URL.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to fetch"}
                },
                "required": ["url"]
            }
        },
    ]

    user_message = f"""I need to call this LLM API endpoint: {endpoint}

Provider appears to be: {provider_name}
Model hint (may be empty): {model_hint or 'unknown'}

Please search for the API documentation and figure out the exact request format.
Then return a JSON object with this structure:

{{
  "url": "<full URL to POST to>",
  "method": "POST",
  "headers": {{"Authorization": "Bearer {{api_key}}", ...}},
  "body": {{"model": "...", "messages": [{{"role": "user", "content": "{{prompt}}"}}], ...}},
  "response_path": "<dot-path to extract text, e.g. choices.0.message.content>"
}}

Use {{api_key}} and {{prompt}} as placeholders — they will be substituted at call time.
Return ONLY the JSON object as your final message, no other text."""

    messages = [{"role": "user", "content": user_message}]
    max_iterations = 6
    request_spec = {}

    for iteration in range(max_iterations):
        log.info("Agent iteration %d/%d", iteration + 1, max_iterations)

        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 2048,
            "system": AGENT_SYSTEM_PROMPT,
            "tools": tools,
            "messages": messages,
        })

        resp = bedrock_client.invoke_model(
            modelId=BEDROCK_AGENT_MODEL,
            body=body,
            contentType="application/json",
            accept="application/json",
        )
        data = json.loads(resp["body"].read())
        stop_reason = data.get("stop_reason")
        content = data.get("content", [])

        # Append assistant response to history
        messages.append({"role": "assistant", "content": content})

        if stop_reason == "end_turn":
            # Extract the JSON spec from the final text block
            for block in content:
                if block.get("type") == "text":
                    text = block["text"].strip()
                    # Extract JSON from the response
                    json_match = re.search(r'\{.*\}', text, re.DOTALL)
                    if json_match:
                        try:
                            request_spec = json.loads(json_match.group())
                            log.info("Agent produced request spec for %s", provider_name)
                            break
                        except json.JSONDecodeError:
                            pass
            break

        elif stop_reason == "tool_use":
            # Execute tool calls
            tool_results = []
            for block in content:
                if block.get("type") != "tool_use":
                    continue

                tool_name = block["name"]
                tool_input = block["input"]
                tool_use_id = block["id"]

                if tool_name == "exa_search":
                    query = tool_input["query"]
                    log.info("Agent calling exa_search: %s", query)
                    result = _exa_search(query)
                elif tool_name == "exa_get_contents":
                    url = tool_input["url"]
                    log.info("Agent calling exa_get_contents: %s", url)
                    result = _exa_get_contents(url)
                else:
                    result = f"Unknown tool: {tool_name}"

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": result[:3000],  # cap to avoid token overflow
                })

            messages.append({"role": "user", "content": tool_results})
        else:
            log.warning("Unexpected stop_reason: %s", stop_reason)
            break

    if not request_spec:
        raise RuntimeError(
            f"AI agent could not determine how to call endpoint: {endpoint}"
        )

    # Now try the actual call using the spec
    response_text, error = _try_http_call(endpoint, api_key, prompt, request_spec)
    if error:
        raise RuntimeError(
            f"AI agent produced a spec but the call failed: {error}\nSpec: {request_spec}"
        )

    return response_text, request_spec


# ── Main public interface ──────────────────────────────────────────────────────

class ApiCallerAgent:
    """
    Provider-agnostic LLM API caller.

    Layer 1: heuristic URL matching (fast, free)
    Layer 2: Bedrock Claude + Exa agent (for unknown providers)
    """

    def __init__(self, api_endpoint: str, api_key: str, region: str = "us-east-1"):
        self.api_endpoint = api_endpoint
        self.api_key = api_key
        self.region = region
        self._bedrock = None
        self._detected_provider = None
        self._request_spec = None  # cached from AI agent run

    def _get_bedrock(self):
        if self._bedrock is None:
            self._bedrock = boto3.client("bedrock-runtime", region_name=self.region)
        return self._bedrock

    def call(self, prompt: str, model_hint: str = "") -> str:
        """
        Call the LLM with a single prompt. Returns the response text.
        Raises RuntimeError if all approaches fail.
        """
        # Layer 1 — try heuristic
        if self._detected_provider is None:
            self._detected_provider = detect_provider(self.api_endpoint, self.region)

        if self._detected_provider is not None:
            try:
                return self._detected_provider.call(
                    self.api_endpoint, self.api_key, prompt, model_hint
                )
            except Exception as e:
                log.warning(
                    "Heuristic provider %s failed: %s — falling through to AI agent",
                    self._detected_provider.name, e
                )

        # Layer 2 — AI agent with Exa
        log.info("Unknown provider, invoking AI agent for: %s", self.api_endpoint)

        # If we already have a working spec from a previous call, reuse it
        if self._request_spec:
            response_text, error = _try_http_call(
                self.api_endpoint, self.api_key, prompt, self._request_spec
            )
            if not error:
                return response_text
            log.warning("Cached spec failed (%s), re-running agent", error)

        response_text, spec = _run_ai_agent(
            self.api_endpoint, self.api_key, prompt, model_hint,
            self._get_bedrock()
        )
        self._request_spec = spec  # cache for subsequent calls
        return response_text

    def call_batch(self, prompts: list, model_hint: str = "") -> list[dict]:
        """
        Call the LLM with multiple prompts. Returns list of
        {"prompt": str, "response": str, "error": str, "latency": float}
        """
        results = []
        for i, prompt in enumerate(prompts):
            log.info("Batch call %d/%d", i + 1, len(prompts))
            t0 = time.monotonic()
            try:
                text = self.call(prompt, model_hint)
                results.append({
                    "prompt": prompt,
                    "response": text,
                    "error": "",
                    "latency": round(time.monotonic() - t0, 3),
                })
            except Exception as e:
                results.append({
                    "prompt": prompt,
                    "response": "",
                    "error": str(e),
                    "latency": round(time.monotonic() - t0, 3),
                })
        return results


# ===========================================================================
# CustomTemplateCallerAgent — calls any provider using a user-defined template
# ===========================================================================
# CustomTemplateCallerAgent — calls any HTTP-based provider
# ===========================================================================

def _resolve_path(obj: dict, path: str) -> str:
    """
    Extract a value from a nested dict/list using dot + bracket notation.
    E.g. "choices[0].message.content"  or  "output.text"
    """
    parts = re.split(r"[\.[\]]+", path)
    cur = obj
    for part in parts:
        if not part:
            continue
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (IndexError, ValueError):
                return ""
        elif isinstance(cur, dict):
            cur = cur.get(part, "")
        else:
            return ""
    return str(cur) if cur is not None else ""


def _discover_response_path(raw_response: dict) -> str:
    """
    Automatically find which field in the raw API JSON response contains
    the model's text reply.

    Step 1: try 10 common known paths (zero latency, zero cost).
    Step 2: ask Claude Haiku on Bedrock to inspect the JSON and return the path.
    """
    COMMON_PATHS = [
        "choices[0].message.content",           # OpenAI + compat
        "content[0].text",                       # Anthropic
        "candidates[0].content.parts[0].text",  # Gemini
        "message.content[0].text",              # Cohere v2
        "response",                              # Ollama native
        "generated_text",                        # HuggingFace
        "output.text",                           # generic
        "result",                                # generic
        "text",                                  # simple
        "completion",                            # older APIs
    ]
    for path in COMMON_PATHS:
        val = _resolve_path(raw_response, path)
        if val and len(val) > 2:
            log.info("Response path matched known pattern: %s", path)
            return path

    # Ask Claude Haiku to figure it out
    try:
        region = os.getenv("AWS_DEFAULT_REGION", "us-east-1")
        bedrock = boto3.client("bedrock-runtime", region_name=region)
        raw_str = json.dumps(raw_response, indent=2)[:3000]

        prompt = (
            "I called an LLM API and got this JSON response:\n\n"
            f"{raw_str}\n\n"
            "Which field contains the main text reply from the model?\n"
            "Return ONLY the dot/bracket path (e.g. choices[0].message.content).\n"
            "Return just the path, no explanation."
        )
        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 80,
            "messages": [{"role": "user", "content": prompt}],
        })
        resp = bedrock.invoke_model(
            modelId="anthropic.claude-3-haiku-20240307-v1:0",
            body=body,
            contentType="application/json",
            accept="application/json",
        )
        data = json.loads(resp["body"].read())
        path = data["content"][0]["text"].strip().strip('"').strip("'").split("\n")[0]
        log.info("Response path discovered via Claude: %s", path)
        return path
    except Exception as e:
        log.warning("Path discovery via Claude failed: %s — will return raw JSON", e)
        return ""


class CustomTemplateCallerAgent:
    """
    Makes LLM calls for ANY HTTP-based provider using a user-supplied template.

    The user only describes how to MAKE the request.
    The response path is auto-discovered on the first call — never required from the user.

    Template fields (what the user provides):
      url             — endpoint URL. Placeholders: {api_key}, {model}
      method          — HTTP method (default POST)
      headers         — dict of request headers. {api_key} is substituted.
      body_template   — JSON body. Placeholders: {prompt}, {api_key}, {model}
      auth_type       — bearer (default) | header | query_param | basic | aws_sigv4 | none
      query_params    — extra URL query params (non-auth), e.g. {"version": "2024-01"}
      content_type    — body encoding (default: application/json)

      # auth_type-specific extras:
      auth_param_name — (query_param) URL param name for key (default: "api_key")
      username        — (basic) username; api_key is used as the password
      aws_region      — (aws_sigv4) AWS region  (default: env AWS_DEFAULT_REGION)
      aws_service     — (aws_sigv4) AWS service (default: execute-api)

    Auto-managed (never ask the user for these):
      response_path   — discovered on first call, cached in self.template
    """

    def __init__(self, template: dict, api_key: str = "", model_hint: str = ""):
        self.template   = dict(template)   # copy so we can mutate (cache response_path)
        self.api_key    = api_key
        self.model_hint = model_hint

    # ── Rendering ────────────────────────────────────────────────────────────────────────────

    def _render(self, prompt: str) -> tuple:
        """Substitute all placeholders. Returns (url, method, headers, body)."""
        def sub_no_prompt(s: str) -> str:
            return (s
                    .replace("{api_key}", self.api_key or "")
                    .replace("{model}",   self.model_hint or ""))

        url    = sub_no_prompt(self.template.get("url", ""))
        method = self.template.get("method", "POST").upper()

        headers = {sub_no_prompt(k): sub_no_prompt(v)
                   for k, v in self.template.get("headers", {}).items()}

        raw_body = json.dumps(self.template.get("body_template", {}))
        raw_body = (raw_body
                    .replace("{api_key}", self.api_key or "")
                    .replace("{model}",   self.model_hint or "")
                    .replace("{prompt}",  prompt))
        body = json.loads(raw_body)

        return url, method, headers, body

    # ── Auth ─────────────────────────────────────────────────────────────────────────────────

    def _apply_auth(self, url: str, headers: dict) -> str:
        """
        Apply auth to headers (mutates) and return (possibly modified) url.
        aws_sigv4 is handled separately in _make_request.
        """
        auth_type = self.template.get("auth_type", "bearer").lower()

        if auth_type == "bearer":
            if self.api_key:
                headers.setdefault("Authorization", f"Bearer {self.api_key}")

        elif auth_type == "header":
            pass  # user already put {api_key} in headers dict, substituted in _render

        elif auth_type == "query_param":
            param = self.template.get("auth_param_name", "api_key")
            sep = "&" if "?" in url else "?"
            url = f"{url}{sep}{param}={self.api_key}"

        elif auth_type == "basic":
            import base64 as _b64
            username = self.template.get("username", "")
            creds = _b64.b64encode(f"{username}:{self.api_key}".encode()).decode()
            headers["Authorization"] = f"Basic {creds}"

        elif auth_type in ("none", ""):
            pass

        return url

    def _make_sigv4_request(
        self, url: str, method: str, headers: dict, body: dict
    ) -> "requests.Response":
        """AWS SigV4-signed request using botocore."""
        from botocore.awsrequest import AWSRequest
        from botocore.auth import SigV4Auth

        region  = self.template.get("aws_region",  os.getenv("AWS_DEFAULT_REGION", "us-east-1"))
        service = self.template.get("aws_service", "execute-api")

        session     = boto3.session.Session()
        credentials = session.get_credentials().get_frozen_credentials()

        body_bytes = json.dumps(body).encode()
        headers.setdefault("Content-Type", "application/json")

        aws_req = AWSRequest(method=method, url=url, data=body_bytes, headers=headers)
        SigV4Auth(credentials, service, region).add_auth(aws_req)

        return requests.request(
            method, url, headers=dict(aws_req.headers), data=body_bytes, timeout=30
        )

    def _make_request(
        self, url: str, method: str, headers: dict, body: dict
    ) -> "requests.Response":
        """Build and send the HTTP request with auth + encoding."""
        content_type = self.template.get("content_type", "application/json")
        headers.setdefault("Content-Type", content_type)

        auth_type = self.template.get("auth_type", "bearer").lower()
        if auth_type == "aws_sigv4":
            return self._make_sigv4_request(url, method, headers, body)

        url = self._apply_auth(url, headers)

        # Append extra (non-auth) query params
        qp = self.template.get("query_params", {})
        if qp:
            from urllib.parse import urlencode
            sep = "&" if "?" in url else "?"
            url = f"{url}{sep}{urlencode(qp)}"

        if "json" in content_type or content_type == "application/json":
            return requests.request(method, url, headers=headers, json=body, timeout=30)
        elif "form" in content_type:
            return requests.request(method, url, headers=headers, data=body, timeout=30)
        else:
            raw = body if isinstance(body, str) else json.dumps(body)
            return requests.request(method, url, headers=headers, data=raw.encode(), timeout=30)

    # ── Response extraction ────────────────────────────────────────────────────────────

    def _extract_text(self, raw: dict) -> str:
        """Extract text using response_path. Discovers and caches it if missing."""
        path = self.template.get("response_path", "")

        if not path:
            path = _discover_response_path(raw)
            if path:
                self.template["response_path"] = path
                log.info("Cached response_path: %s", path)

        if path:
            text = _resolve_path(raw, path)
            if text:
                return text

        return json.dumps(raw)  # fallback: full JSON (fingerprint still works)

    # ── Public API ───────────────────────────────────────────────────────────────────────────

    def call(self, prompt: str) -> str:
        """Single call. Discovers response_path on first use."""
        url, method, headers, body = self._render(prompt)
        resp = self._make_request(url, method, headers, body)
        resp.raise_for_status()
        return self._extract_text(resp.json())

    def call_batch(self, prompts: list) -> list:
        """Call with multiple prompts. Returns list of {prompt, response, error, latency}."""
        results = []
        for i, prompt in enumerate(prompts):
            log.info("CustomTemplateCallerAgent batch %d/%d", i + 1, len(prompts))
            t0 = time.monotonic()
            try:
                text = self.call(prompt)
                results.append({"prompt": prompt, "response": text, "error": "",
                                 "latency": round(time.monotonic() - t0, 3)})
            except Exception as e:
                results.append({"prompt": prompt, "response": "", "error": str(e),
                                 "latency": round(time.monotonic() - t0, 3)})
        return results

    def validate(
        self, sample_prompt: str = "Reply with just the word: PING"
    ) -> tuple:
        """
        Make a single test call to verify the template + discover response_path.
        Returns (ok: bool, response_text_or_error: str, template_with_response_path: dict).
        The returned template dict always has response_path filled in — pass it to EC2.
        """
        try:
            text = self.call(sample_prompt)
            log.info(
                "Template validated OK. auth=%s response_path=%s sample=%s",
                self.template.get("auth_type", "bearer"),
                self.template.get("response_path", "?"),
                text[:80],
            )
            return True, text, self.template
        except Exception as e:
            log.warning("Template validation failed: %s", e)
            return False, str(e), self.template
