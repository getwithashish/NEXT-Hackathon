"""
DiscoveryAgent: Discovers LLM API providers using Exa search + AWS Bedrock (Nova Lite).
"""

import json
import logging
import os
import re
from urllib.parse import urlparse

import boto3
import exa_py

logger = logging.getLogger(__name__)


SEARCH_QUERIES = [
    "LLM API provider",
    "language model API pricing",
    "AI model inference API",
    "open source LLM hosted API",
    "chat completion API",
    "AI model API free tier",
    "LLM as a service",
    "foundation model API",
    "OpenAI compatible API",
    "new AI model provider",
]

EXTRACTION_PROMPT = """You are a data extraction assistant. Given a URL for a potential LLM API provider, extract structured information about the provider.

URL: {url}

Return ONLY a valid JSON object (no markdown, no explanation) with the following fields:
{{
  "name": "Provider name (string)",
  "base_url": "Base API URL (string)",
  "docs_url": "Documentation URL (string or null)",
  "pricing_url": "Pricing page URL (string or null)",
  "free_tier": true or false (boolean — does it offer a free tier?),
  "requires_payment": true or false (boolean — does it require a credit card or payment to start?),
  "model_ids": ["list", "of", "model", "name", "strings"],
  "notes": "Any relevant notes about the provider (string)"
}}

If you cannot determine a field with confidence, use null for strings and false for booleans. For model_ids, return an empty list if unknown.
Return ONLY the JSON object — nothing else."""


def _extract_domain(url: str) -> str:
    """Extract the netloc (domain) from a URL for deduplication."""
    try:
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
        # Strip www. prefix for cleaner deduplication
        if domain.startswith("www."):
            domain = domain[4:]
        return domain
    except Exception:
        return url


def _parse_json_from_response(text: str) -> dict | None:
    """
    Attempt to parse a JSON object from the model response.
    Handles cases where the model wraps JSON in markdown code fences.
    """
    if not text or not text.strip():
        return None

    # Try direct parse first
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        pass

    # Try extracting from markdown code fences
    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence_match:
        try:
            return json.loads(fence_match.group(1))
        except json.JSONDecodeError:
            pass

    # Try finding the first { ... } block
    brace_match = re.search(r"\{.*\}", text, re.DOTALL)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError:
            pass

    return None


class DiscoveryAgent:
    """
    Discovers LLM API providers by:
    1. Running diverse Exa searches to collect candidate URLs.
    2. Using AWS Bedrock (Nova Lite) to extract structured provider info from each URL.
    3. Deduplicating results by base_url domain.
    """

    def __init__(self):
        exa_api_key = os.environ.get("EXA_API_KEY")
        if not exa_api_key:
            raise ValueError("EXA_API_KEY environment variable is not set.")

        self.exa = exa_py.Exa(api_key=exa_api_key)
        self.bedrock = boto3.client(
            service_name="bedrock-runtime",
            region_name="us-east-1",
        )
        self.model_id = "us.anthropic.claude-haiku-4-5-20251001-v1:0"

    def _search_all_queries(self, existing_urls: set) -> list[str]:
        """Run all search queries and return a deduplicated list of new URLs."""
        seen_urls: set[str] = set()
        candidate_urls: list[str] = []

        for query in SEARCH_QUERIES:
            try:
                logger.info(f"Searching Exa for: {query!r}")
                results = self.exa.search(
                    query,
                    num_results=5,
                    type="auto",
                )
                for result in results.results:
                    url = result.url
                    if not url:
                        continue
                    if url in existing_urls:
                        logger.debug(f"Skipping existing URL: {url}")
                        continue
                    if url in seen_urls:
                        continue
                    seen_urls.add(url)
                    candidate_urls.append(url)
                    logger.debug(f"Found candidate URL: {url}")
            except Exception as exc:
                logger.warning(f"Exa search failed for query {query!r}: {exc}")
                continue

        logger.info(
            f"Collected {len(candidate_urls)} unique candidate URLs "
            f"across {len(SEARCH_QUERIES)} queries."
        )
        return candidate_urls

    def _extract_provider_info(self, url: str) -> dict | None:
        """
        Call Claude Haiku via Bedrock to extract structured provider info for a URL.
        Returns a parsed dict or None on failure.
        """
        prompt = EXTRACTION_PROMPT.format(url=url)

        request_body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1024,
            "temperature": 0.0,
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "text", "text": prompt}],
                }
            ],
        }

        try:
            response = self.bedrock.invoke_model(
                modelId=self.model_id,
                contentType="application/json",
                accept="application/json",
                body=json.dumps(request_body),
            )
            body = json.loads(response["body"].read())
            # Claude on Bedrock response format: content[0].text
            output_text = body.get("content", [{}])[0].get("text", "")
            provider = _parse_json_from_response(output_text)
            if provider is None:
                logger.warning(
                    f"Could not parse JSON from Claude response for URL: {url}. "
                    f"Raw output: {output_text[:200]!r}"
                )
            return provider
        except Exception as exc:
            logger.warning(f"Bedrock extraction failed for URL {url!r}: {exc}")
            return None

    def run(self, existing_urls: set) -> list[dict]:
        """
        Discover LLM API providers.

        Args:
            existing_urls: A set of URLs already known/tracked. Results whose
                           URLs appear in this set are skipped.

        Returns:
            A list of provider dicts with keys:
              name, base_url, docs_url, pricing_url, free_tier,
              requires_payment, model_ids, notes
        """
        candidate_urls = self._search_all_queries(existing_urls)

        seen_domains: set[str] = set()
        providers: list[dict] = []

        for url in candidate_urls:
            domain = _extract_domain(url)
            if domain and domain in seen_domains:
                logger.debug(f"Skipping duplicate domain {domain!r} (from {url})")
                continue

            logger.info(f"Extracting provider info for: {url}")
            provider = self._extract_provider_info(url)

            if not provider:
                logger.debug(f"No provider info extracted for: {url}")
                continue

            # Use the extracted base_url's domain for dedup if available,
            # otherwise fall back to the search-result URL domain.
            extracted_base = provider.get("base_url") or ""
            dedup_domain = _extract_domain(extracted_base) if extracted_base else domain

            if dedup_domain and dedup_domain in seen_domains:
                logger.debug(
                    f"Skipping provider with duplicate domain {dedup_domain!r}"
                )
                continue

            if dedup_domain:
                seen_domains.add(dedup_domain)
            # Also mark the original domain as seen
            if domain:
                seen_domains.add(domain)

            # Ensure required fields exist with sensible defaults
            provider.setdefault("name", domain)
            provider.setdefault("base_url", url)
            provider.setdefault("docs_url", None)
            provider.setdefault("pricing_url", None)
            provider.setdefault("free_tier", False)
            provider.setdefault("requires_payment", False)
            provider.setdefault("model_ids", [])
            provider.setdefault("notes", "")

            providers.append(provider)
            logger.info(
                f"Discovered provider: {provider.get('name')!r} "
                f"at {provider.get('base_url')!r}"
            )

        logger.info(f"Discovery complete. Found {len(providers)} new providers.")
        return providers
