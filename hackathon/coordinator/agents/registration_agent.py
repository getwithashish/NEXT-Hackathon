"""
RegistrationAgent: Automates provider sign-up, email verification, and API key extraction.
Dependencies: playwright, boto3, imaplib (stdlib), secrets, re, asyncio
"""

import asyncio
import imaplib
import email
import re
import secrets
import string
import time
import json
import logging
from typing import Optional

import boto3
from playwright.async_api import async_playwright, TimeoutError as PWTimeoutError

logger = logging.getLogger(__name__)


def _generate_password(length: int = 16) -> str:
    """Generate a secure password with alphanumeric + symbols."""
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*"
    while True:
        pwd = "".join(secrets.choice(alphabet) for _ in range(length))
        # Ensure at least one of each required category
        if (
            any(c.isupper() for c in pwd)
            and any(c.islower() for c in pwd)
            and any(c.isdigit() for c in pwd)
            and any(c in "!@#$%^&*" for c in pwd)
        ):
            return pwd


def _analyze_docs_with_nova(docs_url: str, provider_name: str) -> dict:
    """
    Use Amazon Nova Lite (via Bedrock) to analyze the provider docs page
    and extract signup metadata.
    Returns: {signup_url, form_fields, email_verification_required, free_api_key_available}
    """
    client = boto3.client("bedrock-runtime", region_name="us-east-1")

    prompt = f"""You are a web automation assistant. I need to sign up for an API service called "{provider_name}".
The documentation/signup page is at: {docs_url}

Based on your knowledge of this service (or by reasoning about the URL), extract the following information as JSON:
{{
  "signup_url": "<direct URL to the signup/registration form>",
  "form_fields": ["<list of expected form field names, e.g. email, password, name, company>"],
  "email_verification_required": <true or false>,
  "free_api_key_available": <true or false>
}}

Respond ONLY with valid JSON. No extra text."""

    body = json.dumps(
        {
            "messages": [{"role": "user", "content": prompt}],
            "inferenceConfig": {"maxTokens": 512, "temperature": 0.1},
        }
    )

    response = client.invoke_model(
        modelId="us.amazon.nova-lite-v1:0",
        body=body,
        contentType="application/json",
        accept="application/json",
    )

    result_body = json.loads(response["body"].read())
    # Nova response structure: output.message.content[0].text
    raw_text = (
        result_body.get("output", {})
        .get("message", {})
        .get("content", [{}])[0]
        .get("text", "{}")
    )

    # Strip markdown code fences if present
    raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text.strip())
    raw_text = re.sub(r"\s*```$", "", raw_text.strip())

    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        logger.warning("Nova returned non-JSON: %s", raw_text)
        parsed = {}

    return {
        "signup_url": parsed.get("signup_url", ""),
        "form_fields": parsed.get("form_fields", ["email", "password"]),
        "email_verification_required": bool(parsed.get("email_verification_required", False)),
        "free_api_key_available": bool(parsed.get("free_api_key_available", True)),
    }


def _poll_imap_for_verification(
    imap_host: str,
    imap_user: str,
    imap_pass: str,
    target_email: str,
    timeout: int = 60,
    poll_interval: int = 5,
) -> Optional[str]:
    """
    Poll IMAP inbox for a verification email containing an OTP or verification link.
    Returns the OTP code or verification URL, or None if not found within timeout.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            mail = imaplib.IMAP4_SSL(imap_host)
            mail.login(imap_user, imap_pass)
            mail.select("INBOX")

            # Search for unseen emails
            status, messages = mail.search(None, "UNSEEN")
            if status == "OK" and messages[0]:
                for msg_id in messages[0].split():
                    _, msg_data = mail.fetch(msg_id, "(RFC822)")
                    if not msg_data or not isinstance(msg_data[0], tuple):
                        continue
                    raw_bytes = msg_data[0][1]
                    if not isinstance(raw_bytes, bytes):
                        continue
                    msg = email.message_from_bytes(raw_bytes)

                    body = ""
                    if msg.is_multipart():
                        for part in msg.walk():
                            ctype = part.get_content_type()
                            if ctype in ("text/plain", "text/html"):
                                try:
                                    payload = part.get_payload(decode=True)
                                    if isinstance(payload, bytes):
                                        body += payload.decode("utf-8", errors="ignore")
                                except Exception:
                                    pass
                    else:
                        try:
                            payload = msg.get_payload(decode=True)
                            if isinstance(payload, bytes):
                                body = payload.decode("utf-8", errors="ignore")
                        except Exception:
                            pass

                    # Look for verification URLs
                    url_match = re.search(
                        r"https?://[^\s\"'<>]+(?:verify|confirm|activate|token)[^\s\"'<>]*",
                        body,
                        re.IGNORECASE,
                    )
                    if url_match:
                        mail.store(msg_id, "+FLAGS", "\\Seen")
                        mail.logout()
                        return url_match.group(0)

                    # Look for OTP codes (4-8 digit numbers)
                    otp_match = re.search(r"\b(\d{4,8})\b", body)
                    if otp_match:
                        mail.store(msg_id, "+FLAGS", "\\Seen")
                        mail.logout()
                        return otp_match.group(1)

            mail.logout()
        except Exception as e:
            logger.warning("IMAP poll error: %s", e)

        time.sleep(poll_interval)

    return None


async def _fill_and_submit_form(
    page,
    signup_url: str,
    form_fields: list,
    email_addr: str,
    password: str,
) -> dict:
    """
    Navigate to signup URL, detect and fill form fields, submit.
    Returns {success, notes} with special flags for captcha/phone.
    """
    await page.goto(signup_url, wait_until="domcontentloaded", timeout=30_000)
    await page.wait_for_timeout(2000)

    # CAPTCHA detection
    captcha_indicators = [
        "iframe[src*='recaptcha']",
        "iframe[src*='hcaptcha']",
        ".g-recaptcha",
        ".h-captcha",
        "[data-sitekey]",
        "iframe[src*='captcha']",
    ]
    for selector in captcha_indicators:
        if await page.query_selector(selector):
            return {"success": False, "notes": "captcha_required"}

    # Phone field detection
    phone_selectors = [
        "input[type='tel']",
        "input[name*='phone']",
        "input[placeholder*='phone']",
        "input[id*='phone']",
    ]
    for selector in phone_selectors:
        el = await page.query_selector(selector)
        if el and await el.is_visible():
            return {"success": False, "notes": "phone_required"}

    # Fill common fields
    field_map = {
        "email": email_addr,
        "password": password,
        "confirm_password": password,
        "password_confirmation": password,
        "name": "Hackathon Researcher",
        "full_name": "Hackathon Researcher",
        "username": "hackathon_researcher",
        "first_name": "Hackathon",
        "last_name": "Researcher",
        "company": "Hackathon",
        "organization": "Hackathon",
    }

    # Try to fill each field by various selectors
    filled = set()
    for field_name, value in field_map.items():
        selectors = [
            f"input[name='{field_name}']",
            f"input[id='{field_name}']",
            f"input[placeholder*='{field_name}']",
            f"input[autocomplete='{field_name}']",
        ]
        for sel in selectors:
            try:
                el = await page.query_selector(sel)
                if el and await el.is_visible():
                    await el.fill(value)
                    filled.add(field_name)
                    break
            except Exception:
                pass

    # Generic email/password fallback
    if "email" not in filled:
        for sel in ["input[type='email']", "input[placeholder*='mail' i]"]:
            try:
                el = await page.query_selector(sel)
                if el and await el.is_visible():
                    await el.fill(email_addr)
                    filled.add("email")
                    break
            except Exception:
                pass

    if "password" not in filled:
        pw_fields = await page.query_selector_all("input[type='password']")
        for pw_el in pw_fields:
            try:
                if await pw_el.is_visible():
                    await pw_el.fill(password)
                    filled.add("password")
            except Exception:
                pass

    # Accept terms checkbox if present
    for chk_sel in [
        "input[type='checkbox'][name*='terms']",
        "input[type='checkbox'][id*='terms']",
        "input[type='checkbox'][name*='agree']",
        "input[type='checkbox'][name*='accept']",
    ]:
        try:
            el = await page.query_selector(chk_sel)
            if el and not await el.is_checked():
                await el.check()
        except Exception:
            pass

    # Re-check for CAPTCHA after filling
    for selector in captcha_indicators:
        if await page.query_selector(selector):
            return {"success": False, "notes": "captcha_required"}

    # Submit the form
    submit_selectors = [
        "button[type='submit']",
        "input[type='submit']",
        "button:has-text('Sign up')",
        "button:has-text('Register')",
        "button:has-text('Create account')",
        "button:has-text('Get started')",
        "button:has-text('Continue')",
    ]
    submitted = False
    for sel in submit_selectors:
        try:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                await el.click()
                submitted = True
                break
        except Exception:
            pass

    if not submitted:
        return {"success": False, "notes": "submit_button_not_found"}

    await page.wait_for_timeout(3000)
    return {"success": True, "notes": "form_submitted"}


async def _extract_api_key(page, base_url: str) -> Optional[str]:
    """
    Attempt to navigate to the API keys page and extract an API key.
    Tries common API key page patterns.
    """
    api_key_paths = [
        "/api-keys",
        "/api_keys",
        "/settings/api-keys",
        "/settings/api_keys",
        "/account/api-keys",
        "/account/api_keys",
        "/dashboard/api-keys",
        "/console/api-keys",
        "/keys",
        "/settings/keys",
        "/user/api-keys",
        "/developer/api-keys",
    ]

    for path in api_key_paths:
        try:
            url = base_url.rstrip("/") + path
            await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
            await page.wait_for_timeout(2000)

            # Look for "Create" or "Generate" key button
            for btn_sel in [
                "button:has-text('Create')",
                "button:has-text('Generate')",
                "button:has-text('New key')",
                "button:has-text('Add key')",
                "button:has-text('Create API key')",
            ]:
                try:
                    btn = await page.query_selector(btn_sel)
                    if btn and await btn.is_visible():
                        await btn.click()
                        await page.wait_for_timeout(2000)
                        break
                except Exception:
                    pass

            # Extract API key patterns from page text
            content = await page.content()
            # Common API key patterns: sk-..., pk_..., Bearer tokens, long hex/base64 strings
            patterns = [
                r"\b(sk-[A-Za-z0-9\-_]{20,})\b",
                r"\b(pk_[A-Za-z0-9\-_]{20,})\b",
                r"\b(api_[A-Za-z0-9\-_]{20,})\b",
                r"\b([A-Za-z0-9]{32,64})\b",
            ]
            for pattern in patterns:
                match = re.search(pattern, content)
                if match:
                    candidate = match.group(1)
                    # Avoid false positives from common long hex strings (CSS, etc.)
                    if not re.match(r"^[0-9a-f]{32,}$", candidate, re.IGNORECASE):
                        return candidate
                    elif len(candidate) >= 40:
                        return candidate

        except Exception as e:
            logger.debug("API key extraction failed at %s: %s", path, e)
            continue

    # Fallback: look for key in input fields or code blocks anywhere on current page
    try:
        for sel in [
            "input[readonly]",
            "input[type='text'][value]",
            "code",
            "pre",
        ]:
            elements = await page.query_selector_all(sel)
            for el in elements:
                text = await el.text_content() or await el.get_attribute("value") or ""
                key_match = re.search(r"[A-Za-z0-9\-_]{32,}", text.strip())
                if key_match:
                    return key_match.group(0)
    except Exception:
        pass

    return None


class RegistrationAgent:
    """
    Automates provider API registration: analyze docs, fill signup form,
    handle email verification, and extract an API key.
    """

    def __init__(
        self,
        email: str,
        password: str,
        imap_host: str,
        imap_user: str,
        imap_pass: str,
    ):
        self.email = email
        self.password = password  # master password (unused for signup — generated per provider)
        self.imap_host = imap_host
        self.imap_user = imap_user
        self.imap_pass = imap_pass

    async def _register_async(self, provider: dict) -> dict:
        name = provider.get("name", "Unknown")
        base_url = provider.get("base_url", "")
        docs_url = provider.get("docs_url", base_url)

        generated_password = _generate_password(16)
        result = {
            "success": False,
            "api_key": None,
            "email_used": self.email,
            "password_used": generated_password,
            "notes": "",
        }

        # Step 1: Analyze docs with Nova Lite
        logger.info("Analyzing docs for provider: %s", name)
        try:
            meta = _analyze_docs_with_nova(docs_url, name)
        except Exception as e:
            logger.error("Nova analysis failed: %s", e)
            meta = {
                "signup_url": base_url.rstrip("/") + "/signup",
                "form_fields": ["email", "password"],
                "email_verification_required": True,
                "free_api_key_available": True,
            }

        signup_url = meta.get("signup_url") or (base_url.rstrip("/") + "/signup")
        email_verification_required = meta.get("email_verification_required", False)

        logger.info(
            "Signup URL: %s | Email verification: %s", signup_url, email_verification_required
        )

        # Step 2: Playwright automation
        try:
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(headless=True)
                context = await browser.new_context(
                    user_agent=(
                        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    )
                )
                page = await context.new_page()
                page.set_default_timeout(30_000)

                # Step 3: Fill and submit signup form
                form_result = await asyncio.wait_for(
                    _fill_and_submit_form(
                        page,
                        signup_url,
                        meta.get("form_fields", []),
                        self.email,
                        generated_password,
                    ),
                    timeout=60,
                )

                if not form_result["success"]:
                    result["notes"] = form_result["notes"]
                    await browser.close()
                    return result

                # Step 4: Email verification
                if email_verification_required:
                    logger.info("Polling IMAP for verification email...")
                    verification = await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: _poll_imap_for_verification(
                            self.imap_host,
                            self.imap_user,
                            self.imap_pass,
                            self.email,
                            timeout=60,
                            poll_interval=5,
                        ),
                    )

                    if verification:
                        if verification.startswith("http"):
                            # Verification link — navigate to it
                            logger.info("Navigating to verification URL: %s", verification)
                            await page.goto(
                                verification, wait_until="domcontentloaded", timeout=20_000
                            )
                            await page.wait_for_timeout(2000)
                        else:
                            # OTP code — look for OTP input and fill it
                            logger.info("Entering OTP: %s", verification)
                            for otp_sel in [
                                "input[name*='otp']",
                                "input[name*='code']",
                                "input[name*='token']",
                                "input[placeholder*='code' i]",
                                "input[type='number']",
                            ]:
                                try:
                                    el = await page.query_selector(otp_sel)
                                    if el and await el.is_visible():
                                        await el.fill(verification)
                                        # Submit OTP form
                                        submit_btn = await page.query_selector(
                                            "button[type='submit']"
                                        )
                                        if submit_btn:
                                            await submit_btn.click()
                                        await page.wait_for_timeout(2000)
                                        break
                                except Exception:
                                    pass
                    else:
                        result["notes"] = "email_verification_timeout"
                        await browser.close()
                        return result

                # Step 5: Extract API key
                logger.info("Extracting API key from %s", base_url)
                api_key = await asyncio.wait_for(
                    _extract_api_key(page, base_url), timeout=40
                )

                await browser.close()

                result["success"] = api_key is not None
                result["api_key"] = api_key
                result["notes"] = "ok" if api_key else "api_key_not_found"
                return result

        except asyncio.TimeoutError:
            result["notes"] = "timeout"
            return result
        except Exception as e:
            logger.exception("Registration failed for %s: %s", name, e)
            result["notes"] = f"error: {e}"
            return result

    def register(self, provider: dict) -> dict:
        """
        Synchronous entry point. Runs the async registration pipeline
        with a 120-second hard timeout.
        """
        try:
            return asyncio.run(
                asyncio.wait_for(self._register_async(provider), timeout=120)
            )
        except asyncio.TimeoutError:
            return {
                "success": False,
                "api_key": None,
                "email_used": self.email,
                "password_used": "",
                "notes": "timeout",
            }
        except Exception as e:
            return {
                "success": False,
                "api_key": None,
                "email_used": self.email,
                "password_used": "",
                "notes": f"error: {e}",
            }
