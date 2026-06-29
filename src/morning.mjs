// morning.mjs — Morning (Greeninvoice) Payments client. BACKEND-ONLY: the key, secret and JWT
// never leave the server. Reads env, fetches + caches a JWT from /account/token, refreshes it
// before expiry, and exposes apiFetch() + payment helpers. The sandbox⇄production switch lives
// here (one env var), so going live is config-only — no code change.
//
// Endpoint/field names below follow Morning's documented API
// (https://greeninvoice.docs.apiary.io/) and are confirmed against the live sandbox by the
// connection test (scripts/morning-test.mjs) before any payment flow is built on top.

// ============================================================================================
// TODO — RE-TEST LIVE PAYMENT URL: the payment flow is built + unit-tested with a mocked
// success, but the live hosted-payment URL was NOT exercised because the sandbox account had no
// active clearing terminal (errorCode 2600). Once a terminal is active:
//   (1) re-run `node scripts/morning-pay-test.mjs` → confirm a real payment URL opens, shows the
//       ₪ amount incl. 18% VAT, with card + Bit;
//   (2) confirm webhook → entitlement → tax invoice auto-issued in RK Bold Finance Ltd's name;
//   (3) confirm recurring (הוראת קבע) for the ₪115/mo subscription tier + cancel;
//   (4) verify the invoice VAT breakdown equals the displayed VAT-inclusive total (income.vatType).
// Then repeat ALL of the above on PRODUCTION (GREENINVOICE_ENV=production) before launch.
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

/**
 * createPaymentForm({ kind, description, amountIncl, client, recurring, origin }) → { url, id }
 * Creates a Morning hosted payment page (card + Bit). On success Morning auto-issues the tax
 * invoice/receipt to the client. Charge is VAT-INCLUSIVE (amountIncl).
 *
 * NOTE (confirm-on-live, see scripts TODO): the exact field for VAT-inclusive pricing and the
 * recurring / standing-order (הוראת קבע) flag for the subscription tier must be verified against
 * a live sandbox invoice once an active clearing terminal exists. The request shape below is the
 * one Morning already accepted up to the clearing step.
 */
export async function createPaymentForm({ kind, description, amountIncl, client = {}, recurring = false, origin }) {
  const base = process.env.BASE_URL || origin;
  const body = {
    description,
    type: DOC_TAX_INVOICE_RECEIPT,
    lang: 'he',
    currency: 'ILS',
    maxPayments: 1,
    client: {
      name: [client.firstName, client.lastName].filter(Boolean).join(' ') || client.name || client.email || 'Customer',
      emails: client.email ? [client.email] : [],
      ...(client.phone ? { phone: String(client.phone) } : {}),
      ...(client.country ? { country: client.country } : {}),
      ...(client.company ? { taxId: '' , businessName: client.company } : {}),
      add: true,
    },
    // Price is VAT-inclusive; vatType=1 marks the line taxable so the 18% VAT is broken out on the
    // invoice. TODO(confirm-live): verify the invoice total equals amountIncl and VAT shows 18%.
    income: [{ description, quantity: 1, price: amountIncl, currency: 'ILS', vatType: 1 }],
    remarks: `EOC Assistant · ${kind}`,
    successUrl: `${origin}/?paid=${kind}`,
    failureUrl: `${origin}/?canceled=1`,
    notifyUrl: `${base}/pay/callback`,
    // TODO(confirm-live): recurring/standing-order field for the monthly subscription tier.
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
