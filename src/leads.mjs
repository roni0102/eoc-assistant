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

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const validEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(norm(s));
export const validPhone = (s) => (norm(s).match(/\d/g) || []).length >= 7 && /^[\d\s+\-().]{7,}$/.test(norm(s));
export const validCompany = (s) => norm(s).length >= 2;

// Sessions: token -> lead id. Persisted to disk so a token stays valid across instance
// restarts/sleep-wake (otherwise returning visitors get re-gated constantly on the free plan).
const sessions = new Map();

// Free-plan question cap (to control token spend). Override with FREE_QUERY_LIMIT.
// Airtight: keyed by EMAIL (not the session token) and persisted to disk, so re-submitting
// the gate with the same email does NOT reset the quota, and it survives instance restarts.
// (On the free Render plan, data/ is wiped by a code redeploy; attach a persistent disk +
// DATA_DIR to make it permanent across redeploys too.)
const FREE_LIMIT = Number(process.env.FREE_QUERY_LIMIT || 10);
const tokenEmail = new Map(); // token -> email (so a query can find its lead's email)
const usageByEmail = (() => {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8')))); }
  catch { return new Map(); }
})();
function persistUsage() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(USAGE_PATH, JSON.stringify(Object.fromEntries(usageByEmail))); } catch {}
}
const emailKey = (token) => String(tokenEmail.get(token) || token).toLowerCase();

export const freeLimit = () => FREE_LIMIT;
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
      if (v && v.id) { sessions.set(tok, v.id); if (v.email) tokenEmail.set(tok, v.email); }
    }
  } catch {}
})();
function persistSessions() {
  try {
    const obj = {};
    for (const [tok, id] of sessions) obj[tok] = { id, email: tokenEmail.get(tok) || '' };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify(obj));
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
export function addLead({ email, phone, company }) {
  email = norm(email); phone = norm(phone); company = norm(company);
  if (!validEmail(email)) return { ok: false, error: 'Please enter a valid email address.' };
  if (!validPhone(phone)) return { ok: false, error: 'Please enter a valid phone number.' };
  if (!validCompany(company)) return { ok: false, error: 'Please enter your company name.' };
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
  return { ok: true };
}

export function stats() { return { leads: allLeads().length }; }
