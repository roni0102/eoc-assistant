# Connecting payments (Grow / Meshulam)

The whole billing system is already built and wired into the site. **Until you add Grow
credentials, nothing changes** — the site runs in its current mode (free questions capped at
10, expert is free, premium uses the dev/license gate). The moment the env vars below are set,
billing turns ON automatically.

## What customers can buy
| Product | Type | Unlocks |
|---|---|---|
| **EOC review** | one-time | one full ITL-style review of an uploaded EOC |
| **Expert consultation** | one-time | booking one 30-minute online meeting with an ITL expert |
| **Question pack** | one-time | +N more questions (per-question payment option; N = `GROW_QUESTIONS_PER_PACK`) |
| **Monthly pass** | one-time, 31 days | unlimited questions (bypasses the 10-cap) |

When a visitor hits the free question limit they're offered **both** options: buy a question pack
(per-use) or subscribe (unlimited).

Each purchase is tied to the buyer's **email** (already captured at the gate). Payment methods
(credit card, Bit, Apple/Google Pay, PayPal) are whatever you enable in your Grow dashboard.

## Steps once your Grow account is approved
1. In the Grow (Meshulam) dashboard, create a **payment page** and note its **Page Code**, and
   get your **User ID / API key**. Enable the payment methods you want (incl. PayPal).
2. In **Render → eoc-assistant → Environment**, add:
   - `GROW_USER_ID` = your Grow user id / API key
   - `GROW_PAGE_CODE` = your payment page code
   - `GROW_API_BASE` = `https://sandbox.meshulam.co.il/api/light/server/1.0` (sandbox while testing)
   - `GROW_PRICE_REVIEW` = e.g. `250`  · `GROW_PRICE_CONSULT` = e.g. `400`  · `GROW_PRICE_SUB` = e.g. `99` (ILS)
   - `GROW_PRICE_QUESTIONS` = e.g. `29`  · `GROW_QUESTIONS_PER_PACK` = e.g. `20` (per-question pack)
   - `BASE_URL` = `https://eoc-assistant.onrender.com` (your live URL)
3. In Grow, set the **server callback (cgUrl)** to `https://<your-site>/pay/callback` (the site also
   sends it automatically per payment).
4. Test in **sandbox** with Grow's test cards: buy each product, confirm the feature unlocks.
5. Flip `GROW_API_BASE` to `https://secure.meshulam.co.il/api/light/server/1.0` to go live.

## ⚠️ One thing to finalize with Grow's docs (marked `VERIFY` in `src/billing.mjs`)
The exact request fields and the **callback success field/value** follow Grow's documented
"Light" API, but the gateway's responses must be confirmed against **your** account's API docs +
a sandbox test before going live — specifically:
- the `createPaymentProcess` response shape (we expect `{ status:1, data:{ url } }`), and
- how the callback signals "paid" (we accept `status==1` / `statusCode==2`), plus adding Grow's
  `approveTransaction` / `getPaymentProcessInfo` verification call for safety.

Send me a sandbox test result (or the API doc) and I'll lock these down in 10 minutes.

## Notes
- **Invoices/VAT:** Grow can auto-issue Israeli tax invoices (חשבונית מס) — enable it in their
  dashboard; nothing needed in the code.
- **Monthly pass** is currently a 31-day access purchase (re-bought each month). True auto-renew
  uses Grow's recurring/standing-order API — a later enhancement.
- Entitlements are stored in `data/entitlements.json` (per email). On the free Render plan a code
  redeploy resets it; a persistent disk makes it durable (same as leads/sessions).
