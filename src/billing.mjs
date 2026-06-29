// billing.mjs — payments (Grow / Meshulam) + per-email entitlements.
//
// Products (amounts in ILS, set via env):
//   - review        (one-time)  → +1 EOC review credit
//   - consult       (one-time)  → +1 expert consultation credit
//   - subscription  (one-time "monthly pass") → unlimited free-tier questions for 31 days
//     (true auto-renew can be added later via Grow's recurring API — see GROW_SETUP.md)
//
// Provider: Grow (formerly Meshulam). The ENTITLEMENTS ENGINE below is provider-agnostic;
// only `growCreatePayment()` and `growVerify()` are Grow-specific and env-driven, so the
// gateway can be finalized when the account is approved.
//
// GRACEFUL: if GROW credentials are absent, billingAvailable() is false and the server keeps
// its current behavior (premium = license key, expert = free, ask = 10-question cap).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
const ENT_PATH = path.join(DATA_DIR, 'entitlements.json');
const PENDING_PATH = path.join(DATA_DIR, 'pending_payments.json');

// Payments run through Morning (Greeninvoice). Billing is "available" when the Morning API
// credentials are configured. (The legacy Grow adapter below is unused — kept dormant.)
export const billingAvailable = () => !!(process.env.GREENINVOICE_API_KEY_ID && process.env.GREENINVOICE_API_SECRET);

const GROW = { base: '', userId: '', pageCode: '' }; // legacy, unused

// Prices (ILS) + human descriptions per product. Defaults reflect the published price list;
// each is still overridable via env so they can be tuned without a code change.
const QUESTIONS_PER_PACK = Number(process.env.GROW_QUESTIONS_PER_PACK || 1); // billed per single question
// VAT-INCLUSIVE prices the customer actually pays (clean whole shekels). The "before VAT"
// figure shown alongside is derived from these (price ÷ 1.18), so the math is exact top-down.
const PRICE = {
  review: Number(process.env.GROW_PRICE_REVIEW || 103),       // one-time full EOC review (no membership)
  consult: Number(process.env.GROW_PRICE_CONSULT || 673),     // 30-minute expert meeting
  subscription: Number(process.env.GROW_PRICE_SUB || 115),    // monthly membership
  questions: Number(process.env.GROW_PRICE_QUESTIONS || 6),   // per single question
};
const DESC = {
  review: 'EOC full review (one EOC)',
  consult: '30-minute consultation with an ITL expert',
  subscription: 'EOC Assistant — monthly membership: unlimited questions + full EOC review',
  questions: QUESTIONS_PER_PACK === 1 ? 'EOC Assistant — 1 more question' : `EOC Assistant — ${QUESTIONS_PER_PACK} more questions`,
};
// VAT (Israel, 18% as of 2025). PRICE values above ARE VAT-inclusive; ex-VAT is derived for display.
const VAT_RATE = Number(process.env.VAT_RATE || 0.18);
const exVat = (n) => Math.round((Number(n) || 0) / (1 + VAT_RATE) * 100) / 100; // back out VAT (2 decimals)
export const pricing = () => ({
  ...PRICE,                                  // VAT-inclusive (what the customer pays)
  incl: { ...PRICE },                        // explicit alias for the display
  ex: Object.fromEntries(Object.entries(PRICE).map(([k, v]) => [k, exVat(v)])), // ex-VAT, shown as the secondary line
  vatRate: VAT_RATE,
  questionsPack: QUESTIONS_PER_PACK, currency: 'ILS', enabled: billingAvailable(),
});
const MONTH_MS = 31 * 24 * 3600 * 1000;

// ---- Entitlements store (per email) — provider-agnostic, persisted to disk ---------------
const ent = (() => {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(ENT_PATH, 'utf8')))); }
  catch { return new Map(); }
})();
// ---- Pending payments (id → {email, kind}) so a confirmed webhook grants the right thing,
//      idempotently (a duplicate webhook won't double-grant). Persisted to disk. ------------
const pending = (() => {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')))); } catch { return new Map(); }
})();
function persistPending() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(PENDING_PATH, JSON.stringify(Object.fromEntries(pending))); } catch {} }
export function addPending(id, { email, kind }) {
  pending.set(String(id), { email: String(email || '').toLowerCase().trim(), kind, ts: Date.now(), done: false });
  persistPending();
}
/** Claim a pending payment by id (idempotent — returns null if unknown or already granted). */
export function takePending(id) {
  const r = pending.get(String(id));
  if (!r || r.done) return null;
  r.done = true; persistPending();
  return r;
}
/** Fallback lookup when the webhook id differs from the form id. */
export function findPending({ email, kind } = {}) {
  for (const [id, r] of pending) {
    if (r.done) continue;
    if (email && r.email !== String(email).toLowerCase().trim()) continue;
    if (kind && r.kind !== kind) continue;
    return { id, ...r };
  }
  return null;
}

function persist() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ENT_PATH, JSON.stringify(Object.fromEntries(ent))); } catch {}
}
const key = (e) => String(e || '').toLowerCase().trim();
function rec(email) {
  const k = key(email);
  let r = ent.get(k);
  if (!r) { r = { reviews: 0, consults: 0, subUntil: 0 }; ent.set(k, r); }
  return r;
}

export function entitlements(email) {
  const r = rec(email);
  return { reviews: r.reviews || 0, consults: r.consults || 0, questionCredits: r.questionCredits || 0, subActive: (r.subUntil || 0) > Date.now(), admin: !!r.admin };
}
export const extraQuestions = (email) => rec(email).questionCredits || 0; // purchased question packs raise the cap
export const hasSub = (email) => (rec(email).subUntil || 0) > Date.now();

// ---- Admin / owner bypass — the key lives ONLY in the ADMIN_KEY env var (never in code/repo).
// A correct key unlocks unlimited questions + free EOC reviews for that session's email.
export const adminConfigured = () => !!process.env.ADMIN_KEY;
export const adminKeyValid = (k) => !!(process.env.ADMIN_KEY && String(k || '').trim() === process.env.ADMIN_KEY);
export const isAdmin = (email) => !!rec(email).admin;
export function grantAdmin(email) { const r = rec(email); r.admin = true; persist(); return true; }
export function useReview(email) { const r = rec(email); if ((r.reviews || 0) <= 0) return false; r.reviews--; persist(); return true; }
export function useConsult(email) { const r = rec(email); if ((r.consults || 0) <= 0) return false; r.consults--; persist(); return true; }
export function grant(email, kind) {
  const r = rec(email);
  if (kind === 'review') r.reviews = (r.reviews || 0) + 1;
  else if (kind === 'consult') r.consults = (r.consults || 0) + 1;
  else if (kind === 'subscription') r.subUntil = Date.now() + MONTH_MS;
  else if (kind === 'questions') r.questionCredits = (r.questionCredits || 0) + QUESTIONS_PER_PACK;
  else return false;
  persist();
  return true;
}

// ---- Grow adapter ------------------------------------------------------------------------
// NOTE: implemented to Grow's documented "Light" server API. The exact field names / status
// codes / recurring params MUST be confirmed against your Grow developer docs + sandbox once
// the account is approved (search "VERIFY" here and in GROW_SETUP.md).
async function growCreatePayment({ kind, email, origin, customer }) {
  const sum = PRICE[kind]; // already VAT-inclusive (what the customer pays)
  if (!DESC[kind] || !sum) { const e = new Error('Product not configured (price/kind).'); e.code = 'BAD_KIND'; throw e; }
  const c = customer || {};
  const fullName = [c.firstName, c.lastName].filter(Boolean).join(' ').slice(0, 80);
  const callbackBase = process.env.BASE_URL || origin;
  const body = new URLSearchParams({
    pageCode: GROW.pageCode,
    userId: GROW.userId,
    sum: String(sum),
    description: DESC[kind],
    successUrl: `${origin}/?paid=${kind}`,
    cancelUrl: `${origin}/?canceled=1`,
    cgUrl: `${callbackBase}/pay/callback`, // server-to-server confirmation
    // Prefill the customer's details on Grow's hosted page (VERIFY exact field names vs Grow docs).
    'pageField[email]': key(email),
    ...(fullName ? { 'pageField[fullName]': fullName } : {}),
    ...(c.phone ? { 'pageField[phone]': String(c.phone).slice(0, 20) } : {}),
    ...(c.country ? { 'pageField[country]': String(c.country).slice(0, 40) } : {}),
    cField1: key(email), // we read these back on the callback to know who paid for what
    cField2: kind,
  });
  const res = await fetch(`${GROW.base}/createPaymentProcess`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const data = await res.json().catch(() => ({}));
  // VERIFY: Grow returns { status:1, data:{ url, processId, processToken } } on success.
  if (Number(data.status) !== 1 || !data?.data?.url) {
    const e = new Error('Grow create failed: ' + JSON.stringify(data).slice(0, 200));
    e.code = 'GROW_FAIL'; throw e;
  }
  return { url: data.data.url };
}

/** Create a hosted-payment redirect URL for a product. kind ∈ review|consult|subscription. */
export async function createCheckout({ kind, email, origin, customer }) {
  if (!billingAvailable()) { const e = new Error('Billing is not connected yet.'); e.code = 'NO_BILLING'; throw e; }
  return growCreatePayment({ kind, email, origin, customer });
}

/**
 * Handle Grow's server-to-server callback: confirm the payment, then grant the entitlement.
 * Returns { ok, email, kind }. VERIFY the status mapping + add the approveTransaction/
 * getPaymentProcessInfo verification call against Grow's docs before going live.
 */
export async function handleCallback(body) {
  const b = body || {};
  const email = b.cField1 || b['data[customFields][cField1]'] || b.customFields?.cField1 || '';
  const kind = b.cField2 || b['data[customFields][cField2]'] || b.customFields?.cField2 || '';
  // VERIFY: Grow signals success via status/statusCode — confirm exact field + value.
  const paid = String(b.status) === '1' || String(b.statusCode) === '2' || String(b['data[statusCode]']) === '2';
  if (paid && email && kind) { grant(email, kind); return { ok: true, email, kind }; }
  return { ok: false, email, kind };
}
