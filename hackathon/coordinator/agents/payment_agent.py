"""
PaymentAgent: Automates provider billing using Stripe Issuing (live) or test cards.
Dependencies: stripe, playwright
"""

import asyncio
import logging
import math
from typing import Optional

import stripe
from playwright.async_api import async_playwright, TimeoutError as PWTimeoutError

logger = logging.getLogger(__name__)

# Test card constants (Stripe test mode)
TEST_CARD_NUMBER = "4242424242424242"
TEST_CARD_EXP_MONTH = "12"
TEST_CARD_EXP_YEAR = "34"
TEST_CARD_CVC = "123"


def _create_issuing_card(
    stripe_client, spend_cap_usd: float, cardholder_name: str = "Hackathon Researcher"
) -> dict:
    """
    Create a Stripe Issuing Cardholder + virtual Card with a spending cap.
    Returns: {card_id, card_number, exp_month, exp_year, cvc}
    """
    # 1. Create or reuse a cardholder
    cardholders = stripe_client.issuing.Cardholder.list(limit=5)
    cardholder = None
    for ch in cardholders.auto_paging_iter():
        if ch.name == cardholder_name and ch.status == "active":
            cardholder = ch
            break

    if cardholder is None:
        cardholder = stripe_client.issuing.Cardholder.create(
            name=cardholder_name,
            email="hackathon@example.com",
            type="individual",
            billing={
                "address": {
                    "line1": "123 Hackathon St",
                    "city": "San Francisco",
                    "state": "CA",
                    "postal_code": "94105",
                    "country": "US",
                }
            },
            status="active",
        )

    # Convert USD to cents
    spend_cap_cents = math.ceil(spend_cap_usd * 100)

    # 2. Create a virtual card with spending controls
    card = stripe_client.issuing.Card.create(
        cardholder=cardholder.id,
        currency="usd",
        type="virtual",
        status="active",
        spending_controls={
            "spending_limits": [
                {
                    "amount": spend_cap_cents,
                    "interval": "all_time",
                }
            ],
        },
    )

    # 3. Retrieve full card number (requires special permission in live mode)
    card_details = stripe_client.issuing.Card.retrieve_details(card.id)  # type: ignore[attr-defined]

    return {
        "card_id": card.id,
        "card_number": card_details.number,
        "exp_month": str(card_details.exp_month).zfill(2),
        "exp_year": str(card_details.exp_year)[-2:],
        "cvc": card_details.cvc,
    }


async def _enter_card_on_billing_page(
    page,
    billing_url: str,
    card_number: str,
    exp_month: str,
    exp_year: str,
    cvc: str,
    amount_usd: float,
) -> dict:
    """
    Navigate to the provider billing page and enter card details.
    Returns {success, notes}
    """
    # Billing page URL candidates
    billing_paths = [
        billing_url,
        "/billing",
        "/settings/billing",
        "/account/billing",
        "/dashboard/billing",
        "/upgrade",
        "/subscribe",
        "/payment",
        "/settings/payment",
    ]

    # Determine if we already have a full URL or need to use path variants
    if billing_url.startswith("http"):
        paths_to_try = [billing_url]
    else:
        paths_to_try = billing_paths

    page_found = False
    for url in paths_to_try:
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=20_000)
            await page.wait_for_timeout(1500)

            # Check if this looks like a billing/payment page
            content = await page.content()
            billing_keywords = ["credit card", "payment", "billing", "card number", "subscribe"]
            if any(kw in content.lower() for kw in billing_keywords):
                page_found = True
                break
        except Exception as e:
            logger.debug("Failed to load %s: %s", url, e)
            continue

    if not page_found:
        return {"success": False, "notes": "billing_page_not_found"}

    # Fill card number — handle direct inputs and Stripe iframes
    card_filled = False

    # Try direct inputs first
    card_selectors = [
        "input[name*='card'][name*='number']",
        "input[id*='card'][id*='number']",
        "input[placeholder*='card number' i]",
        "input[placeholder*='1234' i]",
        "input[autocomplete='cc-number']",
        "input[data-testid*='card']",
    ]
    for sel in card_selectors:
        try:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                await el.fill(card_number)
                card_filled = True
                break
        except Exception:
            pass

    # Try Stripe iframe approach
    if not card_filled:
        try:
            stripe_frame = None
            for frame in page.frames:
                if "stripe" in frame.url or "js.stripe.com" in frame.url:
                    stripe_frame = frame
                    break

            if stripe_frame is None:
                # Find iframe elements
                iframes = await page.query_selector_all("iframe")
                for iframe_el in iframes:
                    src = await iframe_el.get_attribute("src") or ""
                    if "stripe" in src:
                        stripe_frame = await iframe_el.content_frame()
                        break

            if stripe_frame:
                cn_input = await stripe_frame.query_selector("input[name='cardnumber']")
                if cn_input:
                    await cn_input.fill(card_number)
                    card_filled = True

                exp_input = await stripe_frame.query_selector("input[name='exp-date']")
                if exp_input:
                    await exp_input.fill(f"{exp_month}/{exp_year}")

                cvc_input = await stripe_frame.query_selector("input[name='cvc']")
                if cvc_input:
                    await cvc_input.fill(cvc)
        except Exception as e:
            logger.debug("Stripe iframe fill failed: %s", e)

    if not card_filled:
        return {"success": False, "notes": "card_input_not_found"}

    # Fill expiry
    exp_selectors = [
        "input[name*='exp']",
        "input[id*='exp']",
        "input[placeholder*='MM' i]",
        "input[autocomplete='cc-exp']",
    ]
    for sel in exp_selectors:
        try:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                # Some forms want MM/YY, others separate fields
                await el.fill(f"{exp_month}/{exp_year}")
                break
        except Exception:
            pass

    # Separate month/year fields
    try:
        month_el = await page.query_selector(
            "select[name*='month'], input[name*='month'], input[id*='month']"
        )
        year_el = await page.query_selector(
            "select[name*='year'], input[name*='year'], input[id*='year']"
        )
        if month_el:
            tag = await month_el.evaluate("el => el.tagName.toLowerCase()")
            if tag == "select":
                await month_el.select_option(exp_month.lstrip("0") or "12")
            else:
                await month_el.fill(exp_month)
        if year_el:
            tag = await year_el.evaluate("el => el.tagName.toLowerCase()")
            full_year = f"20{exp_year}"
            if tag == "select":
                await year_el.select_option(full_year)
            else:
                await year_el.fill(full_year)
    except Exception:
        pass

    # Fill CVC
    cvc_selectors = [
        "input[name*='cvc']",
        "input[name*='cvv']",
        "input[name*='security']",
        "input[id*='cvc']",
        "input[id*='cvv']",
        "input[placeholder*='cvc' i]",
        "input[placeholder*='cvv' i]",
        "input[autocomplete='cc-csc']",
    ]
    for sel in cvc_selectors:
        try:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                await el.fill(cvc)
                break
        except Exception:
            pass

    # Fill amount if there's an amount field
    amount_selectors = [
        "input[name*='amount']",
        "input[id*='amount']",
        "input[placeholder*='amount' i]",
    ]
    for sel in amount_selectors:
        try:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                await el.fill(str(amount_usd))
                break
        except Exception:
            pass

    # Submit the payment form
    submit_selectors = [
        "button[type='submit']",
        "button:has-text('Pay')",
        "button:has-text('Subscribe')",
        "button:has-text('Add card')",
        "button:has-text('Save')",
        "button:has-text('Confirm')",
        "input[type='submit']",
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

    # Wait for response
    await page.wait_for_timeout(4000)

    # Check for 3DS challenge — skip/report
    page_content = await page.content()
    if any(kw in page_content.lower() for kw in ["3d secure", "authentication required", "verify your card"]):
        return {"success": False, "notes": "3ds_required_skipped"}

    # Check for decline indicators
    decline_keywords = ["declined", "card was declined", "payment failed", "unable to process"]
    if any(kw in page_content.lower() for kw in decline_keywords):
        return {"success": False, "notes": "card_declined"}

    # Check for success indicators
    success_keywords = ["payment successful", "success", "thank you", "confirmed", "activated"]
    if any(kw in page_content.lower() for kw in success_keywords):
        return {"success": True, "notes": "payment_successful"}

    # Ambiguous result — assume success if no clear failure
    return {"success": True, "notes": "submitted_unknown_result"}


class PaymentAgent:
    """
    Automates provider billing payments using Stripe Issuing virtual cards
    (live mode) or Stripe test cards (test mode).
    """

    def __init__(self, stripe_secret_key: str, spend_cap_usd: float = 5.0):
        self.stripe_secret_key = stripe_secret_key
        self.spend_cap_usd = spend_cap_usd
        self._is_test_mode = stripe_secret_key.startswith("sk_test_")
        stripe.api_key = stripe_secret_key

    async def _pay_async(self, provider: dict, account: dict, amount_usd: float) -> dict:
        base_url = provider.get("base_url", "")
        billing_url = provider.get("billing_url", base_url.rstrip("/") + "/billing")

        result: dict = {
            "success": False,
            "card_id": None,
            "amount_charged": 0.0,
            "notes": "",
        }

        # Step 1: Determine card details
        if self._is_test_mode:
            # Use Stripe test card directly — no Issuing API needed
            card_info = {
                "card_id": "test_card_4242",
                "card_number": TEST_CARD_NUMBER,
                "exp_month": TEST_CARD_EXP_MONTH,
                "exp_year": TEST_CARD_EXP_YEAR,
                "cvc": TEST_CARD_CVC,
            }
            logger.info("Test mode: using Stripe test card %s", TEST_CARD_NUMBER)
        else:
            # Live mode: create Stripe Issuing virtual card
            effective_cap = min(amount_usd, self.spend_cap_usd)
            logger.info(
                "Live mode: creating Issuing card with cap $%.2f", effective_cap
            )
            try:
                card_info = _create_issuing_card(stripe, effective_cap)
            except stripe.StripeError as e:
                result["notes"] = f"stripe_issuing_error: {e}"
                return result

        result["card_id"] = card_info["card_id"]

        # Step 2: Use Playwright to pay on the billing page
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

                # Log in if session cookies or auth tokens are available
                auth_token = account.get("api_key") or account.get("auth_token")
                if auth_token:
                    # Set auth cookie/header if available
                    await context.add_cookies(
                        [
                            {
                                "name": "auth_token",
                                "value": auth_token,
                                "url": base_url,
                            }
                        ]
                    )

                pay_result = await asyncio.wait_for(
                    _enter_card_on_billing_page(
                        page,
                        billing_url,
                        card_info["card_number"],
                        card_info["exp_month"],
                        card_info["exp_year"],
                        card_info["cvc"],
                        amount_usd,
                    ),
                    timeout=60,
                )

                await browser.close()

                result["success"] = pay_result["success"]
                result["notes"] = pay_result["notes"]
                if pay_result["success"]:
                    result["amount_charged"] = amount_usd

                return result

        except asyncio.TimeoutError:
            result["notes"] = "timeout"
            return result
        except Exception as e:
            logger.exception("Payment failed for %s: %s", provider.get("name"), e)
            result["notes"] = f"error: {e}"
            return result

    def pay_for_provider(
        self, provider: dict, account: dict, amount_usd: float
    ) -> dict:
        """
        Synchronous entry point. Runs the async payment pipeline.
        provider: {name, base_url, billing_url (optional)}
        account: {api_key (optional), auth_token (optional), email, password}
        amount_usd: amount to charge
        """
        try:
            return asyncio.run(self._pay_async(provider, account, amount_usd))
        except Exception as e:
            return {
                "success": False,
                "card_id": None,
                "amount_charged": 0.0,
                "notes": f"error: {e}",
            }
