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
import crypto from 'node:crypto';
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
// Atomic write: write a temp file then rename (atomic on the same fs), so a crash mid-write can
// never truncate/corrupt the real file — which would otherwise load as empty next boot and get
// overwritten with {}, wiping every paying customer's entitlements.
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
function persistPending() { try { writeJsonAtomic(PENDING_PATH, Object.fromEntries(pending)); } catch (e) { try { console.error('[billing] persistPending failed:', e?.message || e); } catch {} } }

// Replay guard: a Morning payment document is granted AT MOST ONCE, ever. Without this, re-POSTing
// a real (still-valid) document id to the unauthenticated webhook would claim pending after pending.
const PROCESSED_PATH = path.join(DATA_DIR, 'processed_docs.json');
const processedDocs = (() => { try { return new Set(JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8'))); } catch { return new Set(); } })();
export const isDocProcessed = (id) => processedDocs.has(String(id));
export function markDocProcessed(id) { processedDocs.add(String(id)); try { writeJsonAtomic(PROCESSED_PATH, [...processedDocs]); } catch (e) { try { console.error('[billing] markDocProcessed failed:', e?.message || e); } catch {} } }

// Map a paid (VAT-inclusive) amount back to a product kind, so the grant is driven by what was
// ACTUALLY paid — not by a fragile email-keyed pending record. Tolerant of ±1 ILS rounding.
export function kindForAmount(amount) {
  const a = Math.round(Number(amount) || 0);
  for (const [kind, price] of Object.entries(PRICE)) if (price && Math.abs(a - Math.round(price)) <= 1) return kind;
  return '';
}
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
  try { writeJsonAtomic(ENT_PATH, Object.fromEntries(ent)); } catch (e) { try { console.error('[billing] persist failed:', e?.message || e); } catch {} }
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

// ---- Renewal reminders: the monthly pass grants 31 days (no auto-charge); we email members a
//      few days before expiry with a renew link. `renewNotifiedFor` stores the subUntil we last
//      reminded about, so each renewal cycle is reminded exactly once. -----------------------
export function subsNeedingRenewalReminder(withinMs) {
  const now = Date.now();
  const out = [];
  for (const [email, r] of ent) {
    const until = r.subUntil || 0;
    if (until <= now) continue;                 // expired or never subscribed
    if (until - now > withinMs) continue;       // not within the reminder window yet
    if (r.renewNotifiedFor === until) continue; // already reminded for this exact period
    out.push({ email, subUntil: until, daysLeft: Math.max(1, Math.ceil((until - now) / (24 * 3600 * 1000))) });
  }
  return out;
}
export function markRenewalReminded(email, subUntil) { const r = rec(email); r.renewNotifiedFor = subUntil; persist(); }

// ---- Admin / owner bypass — the key lives ONLY in the ADMIN_KEY env var (never in code/repo).
// A correct key unlocks unlimited questions + free EOC reviews for that session's email.
export const adminConfigured = () => !!process.env.ADMIN_KEY;
export const adminKeyValid = (k) => {
  const exp = process.env.ADMIN_KEY || ''; const got = String(k || '').trim();
  if (!exp || got.length !== exp.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(exp)); } catch { return false; }
};
export const isAdmin = (email) => !!rec(email).admin;
export function grantAdmin(email) { const r = rec(email); r.admin = true; persist(); return true; }
export function useReview(email) { const r = rec(email); if ((r.reviews || 0) <= 0) return false; r.reviews--; persist(); return true; }
export function useConsult(email) { const r = rec(email); if ((r.consults || 0) <= 0) return false; r.consults--; persist(); return true; }
export function grant(email, kind) {
  const r = rec(email);
  if (kind === 'review') r.reviews = (r.reviews || 0) + 1;
  else if (kind === 'consult') r.consults = (r.consults || 0) + 1;
  else if (kind === 'subscription') r.subUntil = Math.max(r.subUntil || 0, Date.now()) + MONTH_MS; // extend, don't discard remaining days
  else if (kind === 'questions') r.questionCredits = (r.questionCredits || 0) + QUESTIONS_PER_PACK;
  else return false;
  persist();
  return true;
}

// NOTE: payments run through Morning (see morning.mjs + server.mjs /checkout + /pay/callback).
// The former Grow adapter (growCreatePayment/createCheckout) and its unauthenticated
// handleCallback grant-from-body handler were removed — dead code and a forge-a-grant footgun.
