// leads.mjs — lead capture (Deliverable #6).
//
// The entry gate captures the CURRENT visitor's own contact details (email, phone,
// company) and stores them as a lead — these are prospective ITL clients, and lead
// capture is the business goal of the site. This is NOT the anonymity rule: the
// anonymity rule protects PAST clients in the knowledge base; capturing the present
// visitor's details is expected and required, so leads are stored as provided.
//
// Storage: append-only JSONL (data/leads.jsonl). A session token unlocks the app for
// that browser; /ask and /review require it (so the gate can't be bypassed via the API).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Runtime data dir — override with DATA_DIR (e.g. a Render persistent disk) so leads
// survive redeploys. Defaults to the repo's data/ for local dev.
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
const LEADS_PATH = path.join(DATA_DIR, 'leads.jsonl');
const USAGE_PATH = path.join(DATA_DIR, 'usage.json'); // per-email question counts (durable cap)
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json'); // active tokens (survive restarts)
const DEVICES_PATH = path.join(DATA_DIR, 'devices.json'); // per-device free ungated-ask counts

// Atomic write (temp file + rename) so a crash mid-write can't truncate/corrupt a store, which
// would otherwise reload as empty on next boot and get overwritten (losing usage caps/sessions).
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const validEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(norm(s));
export const validPhone = (s) => (norm(s).match(/\d/g) || []).length >= 7 && /^[\d\s+\-().]{7,}$/.test(norm(s));
export const validCompany = (s) => norm(s).length >= 2;

// Sessions: token -> lead id. Persisted to disk so a token stays valid across instance
// restarts/sleep-wake (otherwise returning visitors get re-gated constantly on the free plan).
const sessions = new Map();

// Email verification. PAID benefits (subscription, review/consult/question credits) require a
// VERIFIED token. A token is verified only after its owner enters a 6-digit code we emailed to
// that token's email — so claiming someone else's email (to hijack their paid entitlements) fails,
// because the code is delivered to the real owner, not the claimant. Free-tier asks never need it.
const verifiedTokens = new Set();               // tokens that completed the code round-trip
const verifyCodes = new Map();                  // email -> { code, exp, attempts }
const VERIFY_TTL = 10 * 60 * 1000;              // codes valid 10 minutes
export const isVerified = (token) => verifiedTokens.has(token);
/** Force-verify a token WITHOUT a code — only for privileged flows where identity is already
 *  proven (e.g. a correct ADMIN_KEY). Never call this from an unauthenticated path. */
export function markVerified(token) { if (token && sessions.has(token)) { verifiedTokens.add(token); persistSessions(); return true; } return false; }
/** Begin verification for a token: mint a code for its email. Returns { ok, email, code }. */
export function startVerification(token) {
  const email = tokenEmail.get(token);
  if (!email) return { ok: false, error: 'Your session has no email — please re-enter your details.' };
  const code = String(crypto.randomInt(100000, 1000000)); // always 6 digits
  verifyCodes.set(email, { code, exp: Date.now() + VERIFY_TTL, attempts: 0 });
  return { ok: true, email, code };
}
/** Confirm a code for a token's email. On success, marks THIS token verified (and persists it). */
export function confirmVerification(token, code) {
  const email = tokenEmail.get(token);
  if (!email) return { ok: false, error: 'Your session has no email.' };
  const rec = verifyCodes.get(email);
  if (!rec || Date.now() > rec.exp) return { ok: false, error: 'Code expired — request a new one.' };
  if (rec.attempts >= 5) { verifyCodes.delete(email); return { ok: false, error: 'Too many attempts — request a new code.' }; }
  rec.attempts++;
  if (String(code || '').trim() !== rec.code) return { ok: false, error: 'Incorrect code — please try again.' };
  verifyCodes.delete(email);
  verifiedTokens.add(token);
  persistSessions();
  return { ok: true };
}

// Free-plan question cap (to control token spend). Override with FREE_QUERY_LIMIT.
// Airtight: keyed by EMAIL (not the session token) and persisted to disk, so re-submitting
// the gate with the same email does NOT reset the quota, and it survives instance restarts.
// (On the free Render plan, data/ is wiped by a code redeploy; attach a persistent disk +
// DATA_DIR to make it permanent across redeploys too.)
const FREE_LIMIT = Number(process.env.FREE_QUERY_LIMIT || 5);
const tokenEmail = new Map(); // token -> email (so a query can find its lead's email)
const usageByEmail = (() => {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8')))); }
  catch { return new Map(); }
})();
function persistUsage() {
  try { writeJsonAtomic(USAGE_PATH, Object.fromEntries(usageByEmail)); } catch {}
}
const emailKey = (token) => String(tokenEmail.get(token) || token).toLowerCase();

export const freeLimit = () => FREE_LIMIT;

// Free-tier "value first": a brand-new device may ask FREE_UNGATED questions with NO gate; after
// that, the light email gate is required. Counted per device id (sent by the browser), persisted.
const FREE_UNGATED = Number(process.env.FREE_UNGATED || 1);
const freeAsks = (() => { try { return new Map(Object.entries(JSON.parse(fs.readFileSync(DEVICES_PATH, 'utf8')))); } catch { return new Map(); } })();
function persistDevices() { try { writeJsonAtomic(DEVICES_PATH, Object.fromEntries(freeAsks)); } catch {} }
/** Consume one ungated free question, keyed by the caller-supplied anti-abuse key (the client IP,
 *  which the server derives from cf-connecting-ip — unspoofable). {ok:false} once the quota is spent. */
export function useFreeAsk(key) {
  const k = String(key || '').slice(0, 64) || 'anon';
  const n = freeAsks.get(k) || 0;
  if (n >= FREE_UNGATED) return { ok: false, used: n };
  freeAsks.set(k, n + 1); persistDevices();
  return { ok: true, used: n + 1, remaining: FREE_UNGATED - (n + 1) };
}
/** Read the current free-question quota WITHOUT consuming one — for display ("X free questions left"). */
export function quotaFor(token, extra = 0) {
  const key = emailKey(token);
  const allowance = FREE_LIMIT + (Number(extra) || 0);
  const used = usageByEmail.get(key) || 0;
  return { used, remaining: Math.max(0, allowance - used), limit: FREE_LIMIT, allowance };
}
/** Consume one free question (per email). Returns {ok, used, remaining, limit}; ok:false when over cap. */
export function useQuery(token, extra = 0) {
  const key = emailKey(token);
  const allowance = FREE_LIMIT + (Number(extra) || 0); // purchased question packs raise the cap
  const used = usageByEmail.get(key) || 0;
  if (used >= allowance) return { ok: false, used, remaining: 0, limit: FREE_LIMIT, allowance };
  usageByEmail.set(key, used + 1);
  persistUsage();
  return { ok: true, used: used + 1, remaining: allowance - (used + 1), limit: FREE_LIMIT, allowance };
}

// Load persisted sessions on startup → tokens survive restarts.
(() => {
  try {
    const obj = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    for (const [tok, v] of Object.entries(obj)) {
      if (v && v.id) { sessions.set(tok, v.id); if (v.email) tokenEmail.set(tok, v.email); if (v.verified) verifiedTokens.add(tok); }
    }
  } catch {}
})();
function persistSessions() {
  try {
    const obj = {};
    for (const [tok, id] of sessions) obj[tok] = { id, email: tokenEmail.get(tok) || '', verified: verifiedTokens.has(tok) };
    writeJsonAtomic(SESSIONS_PATH, obj);
  } catch {}
}

// Optional Google Sheets mirror: every new lead is POSTed to a Google Apps Script web
// app (its URL in SHEETS_WEBHOOK_URL) which appends a row to a sheet on the user's Drive.
// Fire-and-forget — a slow or failing webhook must never block or break sign-up, and if
// the env var is unset this is a no-op (local dev / not yet configured).
function sendToSheet(lead) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return;
  Promise.resolve()
    .then(() => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts: lead.ts, company: lead.company, email: lead.email, phone: lead.phone, tier: lead.tier }),
    }))
    .catch((e) => { try { console.error('sheets webhook failed:', e?.message || e); } catch {} });
}

/**
 * addLead({ email, phone, company }) -> { ok, token } | { ok:false, error }
 * Validates, appends the lead, and issues a session token.
 */
export function addLead({ email, phone, company, light }) {
  email = norm(email); phone = norm(phone); company = norm(company);
  if (!validEmail(email)) return { ok: false, error: 'Please enter a valid email address.' };
  if (!light) { // full gate (legacy / non-free): phone + company required
    if (!validPhone(phone)) return { ok: false, error: 'Please enter a valid phone number.' };
    if (!validCompany(company)) return { ok: false, error: 'Please enter your company name.' };
  }
  // light free-tier gate: email required; company optional; phone not asked.
  const lead = { id: crypto.randomBytes(8).toString('hex'), ts: new Date().toISOString(), email, phone, company, tier: 'free' };
  try {
    fs.mkdirSync(path.dirname(LEADS_PATH), { recursive: true });
    fs.appendFileSync(LEADS_PATH, JSON.stringify(lead) + '\n');
  } catch (e) { return { ok: false, error: 'Could not record your details — please try again.' }; }
  sendToSheet(lead); // mirror to Google Sheets (no-op unless SHEETS_WEBHOOK_URL is set)
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, lead.id);
  tokenEmail.set(token, email.toLowerCase()); // bind token→email for the per-email quota
  persistSessions(); // keep the token valid across restarts
  return { ok: true, token };
}

export const validToken = (token) => !!token && sessions.has(token);
export const emailForToken = (token) => tokenEmail.get(token) || '';

/** Note that a lead used the premium tier (appended as an update line). */
export function markTier(token, tier) {
  const id = sessions.get(token);
  if (!id) return;
  try { fs.appendFileSync(LEADS_PATH, JSON.stringify({ id, ts: new Date().toISOString(), tier_update: tier }) + '\n'); } catch {}
}

function readAll() {
  try {
    return fs.readFileSync(LEADS_PATH, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Consolidated leads (latest tier applied), newest first — for export. */
export function allLeads() {
  const rows = readAll();
  const byId = new Map();
  for (const r of rows) {
    if (r.tier_update) { const e = byId.get(r.id); if (e) e.tier = r.tier_update; continue; }
    byId.set(r.id, { ...r });
  }
  return [...byId.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

export function toCSV(leads) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['timestamp', 'company', 'email', 'phone', 'tier'];
  const lines = [head.join(',')];
  for (const l of leads) lines.push([l.ts, l.company, l.email, l.phone, l.tier].map(esc).join(','));
  return lines.join('\n');
}

/** Look up the lead behind a session token (for expert requests). */
function leadForToken(token) {
  const id = sessions.get(token);
  if (!id) return null;
  return allLeads().find((l) => l.id === id) || null;
}

/**
 * addExpertRequest({ token, message }): record a request to talk to a real ITL expert,
 * tied to the visitor's existing lead. Appended to leads.jsonl and mirrored to the sheet
 * (marked EXPERT REQUEST, with the message) so the team can follow up.
 */
/**
 * addExpertRequest({ token, topic, description, slots }): a 30-minute online consultation
 * BOOKING request — the client's topic, short description, and 2-3 proposed date/time options.
 * Recorded to leads.jsonl and mirrored to the sheet so the team confirms a slot + sends a link.
 */
export function addExpertRequest({ token, topic, description, slots }) {
  const lead = leadForToken(token);
  topic = String(topic || '').slice(0, 200).trim();
  description = String(description || '').slice(0, 1500).trim();
  const times = (Array.isArray(slots) ? slots : []).map((s) => String(s || '').slice(0, 40).trim()).filter(Boolean).slice(0, 3);
  if (!topic) return { ok: false, error: 'Please enter a topic.' };
  if (!description) return { ok: false, error: 'Please describe what you need.' };
  if (!times.length) return { ok: false, error: 'Please propose at least one date/time.' };
  const entry = {
    id: lead?.id, ts: new Date().toISOString(),
    consult: { topic, description, slots: times },
    company: lead?.company || '', email: lead?.email || '', phone: lead?.phone || '',
  };
  try {
    fs.mkdirSync(path.dirname(LEADS_PATH), { recursive: true });
    fs.appendFileSync(LEADS_PATH, JSON.stringify(entry) + '\n');
  } catch (e) { return { ok: false, error: 'Could not record your request — please try again.' }; }
  // Mirror to the Google Sheet so the team sees the booking with contact + proposed times.
  const human = `CONSULT (30-min) — Topic: ${topic} | Needs: ${description.slice(0, 280)} | Times: ${times.map((t) => t.replace('T', ' ')).join('  /  ')}`;
  sendToSheet({ ts: entry.ts, company: entry.company, email: entry.email, phone: entry.phone, tier: human.slice(0, 490) });
  return { ok: true, entry };
}

/**
 * recordConsent(token, detail): log that this client accepted the Purchasing Policy & Terms,
 * linked to the email they entered at the gate. Appended to leads.jsonl and mirrored to the
 * Google Sheet so there's an auditable consent trail (who accepted, when, for what).
 */
export function recordConsent(token, detail) {
  const lead = leadForToken(token);
  if (!lead) return { ok: false, error: 'No lead for token.' };
  const entry = {
    id: lead.id, ts: new Date().toISOString(),
    consent: { policy: 'Purchasing Policy & Terms', detail: String(detail || '').slice(0, 120) },
    company: lead.company || '', email: lead.email || '', phone: lead.phone || '',
  };
  try {
    fs.mkdirSync(path.dirname(LEADS_PATH), { recursive: true });
    fs.appendFileSync(LEADS_PATH, JSON.stringify(entry) + '\n');
  } catch (e) { /* non-fatal: the consent still proceeds */ }
  sendToSheet({ ts: entry.ts, company: entry.company, email: entry.email, phone: entry.phone, tier: `POLICY ACCEPTED — ${entry.consent.detail}`.slice(0, 490) });
  return { ok: true, email: lead.email };
}

/**
 * recordBug({ token, message, email, context, ua }): a user-submitted bug report. Saved to
 * leads.jsonl AND mirrored to the Google Sheet (persistent even on an ephemeral disk). Tied to
 * the reporter's lead when a session token is supplied; otherwise just their typed email.
 */
export function recordBug({ token, message, email, context, ua, attachmentName }) {
  const lead = token ? leadForToken(token) : null;
  message = String(message || '').slice(0, 2000).trim();
  if (message.length < 3) return { ok: false, error: 'Please describe the problem.' };
  const attach = String(attachmentName || '').slice(0, 160);
  const entry = {
    id: lead?.id, ts: new Date().toISOString(),
    bug: { message, context: String(context || '').slice(0, 200), ua: String(ua || '').slice(0, 200), attachment: attach },
    company: lead?.company || '',
    email: (String(email || '').slice(0, 160).trim() || lead?.email || ''),
    phone: lead?.phone || '',
  };
  try {
    fs.mkdirSync(path.dirname(LEADS_PATH), { recursive: true });
    fs.appendFileSync(LEADS_PATH, JSON.stringify(entry) + '\n');
  } catch (e) { /* non-fatal */ }
  const note = `BUG REPORT — ${message.slice(0, 400)}${attach ? ` [attachment: ${attach} — see email]` : ''}`;
  sendToSheet({ ts: entry.ts, company: entry.company, email: entry.email, phone: entry.phone, tier: note.slice(0, 480) });
  return { ok: true, entry };
}

export function stats() { return { leads: allLeads().length }; }
