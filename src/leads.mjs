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

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const validEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(norm(s));
export const validPhone = (s) => (norm(s).match(/\d/g) || []).length >= 7 && /^[\d\s+\-().]{7,}$/.test(norm(s));
export const validCompany = (s) => norm(s).length >= 2;

// In-memory sessions: token -> lead id. (Restart invalidates tokens → visitor re-gates;
// the client handles a 401 by re-showing the gate.)
const sessions = new Map();

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
  return { ok: true, token };
}

export const validToken = (token) => !!token && sessions.has(token);

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

export function stats() { return { leads: allLeads().length }; }
