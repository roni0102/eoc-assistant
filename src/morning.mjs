// morning.mjs — Morning (Greeninvoice) Payments client. BACKEND-ONLY: the key, secret and JWT
// never leave the server. Reads env, fetches + caches a JWT from /account/token, refreshes it
// before expiry, and exposes apiFetch() + payment helpers. The sandbox⇄production switch lives
// here (one env var), so going live is config-only — no code change.
//
// Endpoint/field names below follow Morning's documented API
// (https://greeninvoice.docs.apiary.io/) and are confirmed against the live sandbox by the
// connection test (scripts/morning-test.mjs) before any payment flow is built on top.

// ============================================================================================
// STATUS: payment-form creation WORKS in sandbox — createPaymentForm returns a real Meshulam
// hosted-checkout URL (errorCode 2600 was fixed by passing GREENINVOICE_PLUGIN_ID). Still TODO:
//   (1) complete a demo-card payment on the returned URL and confirm the webhook (/pay/callback)
//       fires → entitlement granted → tax invoice (doc 320) auto-issued in RK Bold Finance Ltd's
//       name with 18% VAT (needs the keys + webhook secret set on the public host so Morning can
//       reach notifyUrl);
//   (2) confirm/implement recurring (הוראת קבע) for the ₪115/mo subscription tier + cancel;
//   (3) repeat on PRODUCTION (GREENINVOICE_ENV=production, production plugin id) before launch.
// ============================================================================================
const ENV = (process.env.GREENINVOICE_ENV || 'sandbox').toLowerCase();
const BASE = ENV === 'production'
  ? 'https://api.greeninvoice.co.il/api/v1/'
  : 'https://sandbox.d.greeninvoice.co.il/api/v1/';
const KEY_ID = process.env.GREENINVOICE_API_KEY_ID || '';
const SECRET = process.env.GREENINVOICE_API_SECRET || '';

export const paymentsConfigured = () => !!(KEY_ID && SECRET);
export const env = () => ENV;
export const baseUrl = () => BASE;

let _token = null, _exp = 0; // cached JWT + its expiry (epoch ms)

// Decode the `exp` claim from a JWT (epoch ms). Returns 0 if it can't be parsed.
function decodeJwtExp(jwt) {
  try {
    const seg = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(Buffer.from(seg, 'base64').toString('utf8'));
    return p.exp ? p.exp * 1000 : 0;
  } catch { return 0; }
}

// POST the key id + secret → receive a JWT. Morning returns the token either in the
// `X-Authorization-Bearer` response header or in the JSON body — handle both.
async function fetchToken() {
  const r = await fetch(BASE + 'account/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: KEY_ID, secret: SECRET }),
  });
  const text = await r.text(); let body = {}; try { body = JSON.parse(text); } catch {}
  if (!r.ok) { const e = new Error(`Morning auth failed (${r.status}): ${text.slice(0, 200)}`); e.code = 'AUTH_FAIL'; throw e; }
  const token = r.headers.get('x-authorization-bearer') || body.token || body?.data?.token || '';
  if (!token) { const e = new Error('Morning auth: token not found in response: ' + text.slice(0, 200)); e.code = 'NO_TOKEN'; throw e; }
  const exp = decodeJwtExp(token) || (Date.now() + 50 * 60 * 1000); // fallback ~50 min if exp absent
  return { token, exp };
}

/** Cached token — refreshes when within 60s of expiry. */
export async function getToken() {
  if (!paymentsConfigured()) { const e = new Error('Morning not configured (GREENINVOICE_API_KEY_ID / GREENINVOICE_API_SECRET).'); e.code = 'NO_CONFIG'; throw e; }
  if (_token && Date.now() < _exp - 60000) return _token;
  const { token, exp } = await fetchToken();
  _token = token; _exp = exp;
  return token;
}

/** Authenticated JSON call against the Morning API. */
export async function apiFetch(path, { method = 'GET', body, headers = {} } = {}) {
  const token = await getToken();
  const r = await fetch(BASE + String(path).replace(/^\//, ''), {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text(); let data = {}; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) { const e = new Error(`Morning ${method} ${path} → ${r.status}: ${text.slice(0, 300)}`); e.code = 'API_FAIL'; e.status = r.status; throw e; }
  return data;
}

// Document type 320 = "חשבונית מס/קבלה" (tax invoice + receipt) — issued automatically in the
// ACCOUNT's name (RK Bold Finance Ltd) and emailed to the client on successful payment.
const DOC_TAX_INVOICE_RECEIPT = 320;

// VAT rate used to split the inclusive price into the ex-VAT invoice line (Israel, 18%).
const VAT_RATE = Number(process.env.VAT_RATE || 0.18);
// Morning expects an ISO-3166 country CODE, not a name (errorCode 1104 otherwise).
const COUNTRY_CODE = { Israel: 'IL', 'United States': 'US', 'United Kingdom': 'GB' };
const toCountryCode = (c) => COUNTRY_CODE[c] || (/^[A-Za-z]{2}$/.test(String(c || '')) ? String(c).toUpperCase() : '');

/**
 * createPaymentForm({ kind, description, amountIncl, amountEx, client, recurring, origin }) → { url, id }
 * Creates a Morning hosted payment page (card + Bit) and, on success, auto-issues the tax
 * invoice/receipt (doc 320) in RK Bold Finance Ltd's name. Verified working against the sandbox:
 *   - pluginId (GREENINVOICE_PLUGIN_ID) selects the clearing terminal (without it → errorCode 2600);
 *   - a top-level `description` is required (without it → bare HTTP 400, errorCode 0);
 *   - client.country must be an ISO code, not a name (without it → errorCode 1104);
 *   - `amount` is the VAT-INCLUSIVE charge AND the income line is priced at the same inclusive
 *     amount with vatType:1 (= price INCLUDES VAT), so Greeninvoice extracts the 18% VAT and the
 *     receipt balances exactly. (Pricing the line EX-VAT caused errorCode 2422 "receipts vs
 *     payments mismatch" on tiers where ex×1.18 didn't round back to the whole-shekel price.)
 * `amountEx` is accepted for backward-compat but no longer used.
 */
export async function createPaymentForm({ kind, description, amountIncl, amountEx, client = {}, recurring = false, origin }) {
  const base = process.env.BASE_URL || origin;
  const body = {
    description,                                  // REQUIRED top-level
    type: DOC_TAX_INVOICE_RECEIPT,
    lang: 'he',
    currency: 'ILS',
    vatType: 0,
    amount: amountIncl,                           // VAT-inclusive charge
    maxPayments: 1,
    ...(process.env.GREENINVOICE_PLUGIN_ID ? { pluginId: process.env.GREENINVOICE_PLUGIN_ID } : {}),
    client: {
      name: [client.firstName, client.lastName].filter(Boolean).join(' ') || client.name || client.email || 'Customer',
      emails: client.email ? [client.email] : [],
      ...(client.phone ? { phone: String(client.phone) } : {}),
      ...(toCountryCode(client.country) ? { country: toCountryCode(client.country) } : {}),
      ...(client.company ? { businessName: client.company } : {}),
      add: true,
    },
    // Line priced at the VAT-INCLUSIVE amount with vatType:1 (= price INCLUDES VAT) → the invoice
    // total = amountIncl with 18% VAT extracted, and the receipt balances (no rounding mismatch).
    income: [{ description, quantity: 1, price: amountIncl, currency: 'ILS', vatType: 1 }],
    remarks: `EOC Assistant · ${kind}`,
    successUrl: `${origin}/?paid=${kind}`,
    failureUrl: `${origin}/?canceled=1`,
    notifyUrl: `${base}/pay/callback`,
    // TODO(confirm-live): recurring/standing-order (הוראת קבע) field for the monthly subscription tier.
    ...(recurring ? { /* recurrence config — confirm Morning field names on live */ } : {}),
  };
  const r = await apiFetch('payments/form', { method: 'POST', body });
  return { url: r.url || r?.data?.url || '', id: r.id || r?.data?.id || '', raw: r };
}

/** Fetch a document (invoice/receipt) to confirm it exists + its payment status — webhook proof. */
export async function getDocument(id) {
  return apiFetch(`documents/${encodeURIComponent(id)}`);
}

/** Verify a webhook is authentic via the shared secret set in Morning's Webhooks tab.
 *  Accepts the secret from a header or a body field. If no secret is configured, returns false
 *  (so entitlement is never granted on an unverifiable webhook). */
export function verifyWebhookSecret({ headerSecret, bodySecret }) {
  const expected = process.env.GREENINVOICE_WEBHOOK_SECRET || '';
  if (!expected) return false;
  return headerSecret === expected || bodySecret === expected;
}

/** Connection test — proves the sandbox keys authenticate. Used by scripts/morning-test.mjs. */
export async function diagnose() {
  if (!paymentsConfigured()) return { ok: false, env: ENV, base: BASE, error: 'GREENINVOICE_API_KEY_ID / GREENINVOICE_API_SECRET are not set in the environment.' };
  try {
    const { token, exp } = await fetchToken();
    _token = token; _exp = exp;
    return { ok: true, env: ENV, base: BASE, tokenExpiry: new Date(exp).toISOString(), tokenPreview: token.slice(0, 10) + '…' };
  } catch (e) { return { ok: false, env: ENV, base: BASE, error: String(e?.message || e) }; }
}
