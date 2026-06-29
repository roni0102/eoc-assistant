// morning.mjs — Morning (Greeninvoice) Payments client. BACKEND-ONLY: the key, secret and JWT
// never leave the server. Reads env, fetches + caches a JWT from /account/token, refreshes it
// before expiry, and exposes apiFetch() + payment helpers. The sandbox⇄production switch lives
// here (one env var), so going live is config-only — no code change.
//
// Endpoint/field names below follow Morning's documented API
// (https://greeninvoice.docs.apiary.io/) and are confirmed against the live sandbox by the
// connection test (scripts/morning-test.mjs) before any payment flow is built on top.

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

/** Connection test — proves the sandbox keys authenticate. Used by scripts/morning-test.mjs. */
export async function diagnose() {
  if (!paymentsConfigured()) return { ok: false, env: ENV, base: BASE, error: 'GREENINVOICE_API_KEY_ID / GREENINVOICE_API_SECRET are not set in the environment.' };
  try {
    const { token, exp } = await fetchToken();
    _token = token; _exp = exp;
    return { ok: true, env: ENV, base: BASE, tokenExpiry: new Date(exp).toISOString(), tokenPreview: token.slice(0, 10) + '…' };
  } catch (e) { return { ok: false, env: ENV, base: BASE, error: String(e?.message || e) }; }
}
