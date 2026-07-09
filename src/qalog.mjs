// qalog.mjs — persistent, ANONYMIZED Q&A log + public-display gate.
//
// Every question (free + premium-tier asks) is recorded so the accumulated knowledge can be
// shared with other clients (a growing FAQ) and feed the quarterly "new complex questions"
// newsletter. The asker's question is SCRUBBED before storage (it may contain the asker's own
// client/site/person name). NO user identity is stored with the displayed text — no email,
// phone, company, or IP — only the scrubbed question, the (already-anonymous) answer, a
// timestamp, the clause/chapter it touched, and the language.
//
// PUBLIC GATE (hard anonymity rule): a stored question is only eligible for the PUBLIC panel if,
// after scrubbing, it has NO identifier hits AND needed NO redaction at all. A question that had
// to be redacted (the asker pasted names/codes/contacts) is kept INTERNALLY but EXCLUDED from
// public display — unless an admin manually approves it. So a client's pasted details can never
// leak into the public panel.
//
// Storage: append-only JSONL (data/qa_log.jsonl). Simple, durable, no native deps.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scrub, scan, scanAnswer } from './anonymize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
const LOG_PATH = path.join(DATA_DIR, 'qa_log.jsonl');

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// Any of these placeholders means the original text contained identifying specifics → not public.
const REDACTION_RE = /\[(?:redacted|date|email|phone|path|document ref)\]/i;
const detectLang = (s) => (/[֐-׿]/.test(s) ? 'he' : /[Ѐ-ӿ]/.test(s) ? 'ru' : 'en');
const chapterOf = (clauses) => String((Array.isArray(clauses) && clauses[0]) || '').split('.')[0] || '';

/** Is a SCRUBBED question safe to show publicly? (independent of the answer/approval) */
function autoPublic(scrubbedQ) {
  return scan(scrubbedQ).length === 0 && !REDACTION_RE.test(scrubbedQ);
}
/** Final public eligibility for an entry (manual approval overrides the auto rule). */
function isPublic(e) {
  if (!e || !e.a) return false;                       // need an answer to display
  if (e.approved === true) return true;               // admin-approved
  if (e.approved === false) return false;             // admin-hidden
  return e.pub !== undefined ? !!e.pub : autoPublic(String(e.q || '')); // recompute for legacy rows
}

/**
 * record({ question, answer, clauses, tier, lang, publicQ }): scrub the question (kept INTERNALLY
 * for the owner's log/sheet), keep the already-anonymous answer, and — for the PUBLIC panel — use
 * `publicQ`: an LLM-generated GENERIC, de-identified rephrasing (see llm.genericizeQuestion). The
 * client's own wording is never shown publicly; only the clean rephrasing is. A row is public-
 * eligible ONLY if a non-empty publicQ was supplied AND it passes the anonymity scan. (Rows logged
 * without publicQ — e.g. legacy/seed entries — keep the old "clean scrubbed question" rule.)
 * Fire-and-forget; never throws into the request path.
 */
export function record({ question, answer, clauses, tier, lang, publicQ }) {
  try {
    const q = scrub(norm(question)).slice(0, 600);
    if (!q || q.replace(/\[[^\]]+\]/g, '').replace(/[^\p{L}\p{N}]/gu, '').length < 4) return; // nothing useful left
    const a = scanAnswer(answer || '').length ? '' : norm(answer).slice(0, 4000); // never store a guard-tripping answer
    // publicQ === undefined → caller opted out of the rephrasing layer (legacy: fall back to the
    // scrubbed question). publicQ provided (even '') → public ONLY via a clean rephrasing.
    const pq = publicQ != null ? scrub(norm(publicQ)).slice(0, 300) : null;
    const pub = !!a && (pq != null ? (!!pq && autoPublic(pq)) : autoPublic(q));
    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      ts: new Date().toISOString(),
      tier: tier || 'free',
      q, a,
      ...(pq != null ? { publicQ: pq } : {}), // the de-identified text shown publicly
      clauses: Array.isArray(clauses) ? clauses.slice(0, 6) : [],
      chapter: chapterOf(clauses),
      lang: lang || detectLang(question || q),
      pub,
      approved: null,              // manual override: true=approve, false=hide, null=auto
    };
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
    sendQAToSheet(entry); // mirror to the owner's Google Sheet (no-op unless SHEETS_WEBHOOK_URL set)
  } catch { /* logging must never break answering */ }
}

// Mirror each Q&A to the owner's Google Apps Script web app (SHEETS_WEBHOOK_URL) under type:"qa"
// so it lands on a separate "Q&A" tab. Sends the SCRUBBED question + the public rephrasing + flags
// (never raw text). Fire-and-forget; a no-op if the env var is unset.
function sendQAToSheet(e) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return;
  Promise.resolve()
    .then(() => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'qa', ts: e.ts, q: e.q, publicQ: e.publicQ || '', shown: !!e.pub, chapter: e.chapter || '', lang: e.lang || '', tier: e.tier || '' }),
    }))
    .catch((err) => { try { console.error('qa sheets webhook failed:', err?.message || err); } catch {} });
}

function readAll() {
  try {
    return fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// The text shown publicly: the de-identified rephrasing when present, else the scrubbed question
// (legacy/seed rows). NEW rows are only public when they have a clean publicQ, so raw client
// wording is never surfaced.
// If a row carries a publicQ field (any row logged via the rephrasing path), the public text is
// ONLY that rephrasing — never the raw scrubbed question, even if publicQ is '' (LLM said SKIP:
// not safely generalizable). Only truly-legacy rows (no publicQ field) fall back to the scrubbed q.
const shownQ = (e) => ('publicQ' in e ? (e.publicQ || '') : e.q);

/** recent(limit): most-recent distinct PUBLIC questions, newest first. */
export function recent(limit = 20) {
  const all = readAll();
  const seen = new Set(), out = [];
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    const e = all[i];
    if (!isPublic(e)) continue;
    const disp = shownQ(e);
    if (!disp) continue;                       // approved-but-un-generalizable row → show nothing
    const key = disp.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: e.id, ts: e.ts, q: disp, a: e.a, clauses: e.clauses, chapter: e.chapter || '' });
  }
  return out;
}

/** search(query, limit): lexical match over PUBLIC questions + answers. */
export function search(query, limit = 10) {
  const terms = norm(query).toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!terms.length) return recent(limit);
  const all = readAll().filter(isPublic);
  const scored = all.map((e) => {
    const hay = (shownQ(e) + ' ' + (e.a || '')).toLowerCase(); // match only on text that is shown publicly
    let s = 0; for (const t of terms) if (hay.includes(t)) s++;
    return { e, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const seen = new Set(), out = [];
  for (const { e } of scored) { const disp = shownQ(e); if (!disp) continue; const k = disp.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push({ id: e.id, ts: e.ts, q: disp, a: e.a, clauses: e.clauses, chapter: e.chapter || '' }); if (out.length >= limit) break; }
  return out;
}

// ---- moderation / curation (admin) ------------------------------------------------------
/** Entries awaiting a decision: have an answer but are NOT auto-public (candidates to approve). */
export function pending(limit = 50) {
  return readAll().filter((e) => e.a && e.approved == null && !(e.pub !== undefined ? e.pub : autoPublic(String(e.q || ''))))
    .slice(-limit).reverse()
    .map((e) => ({ id: e.id, ts: e.ts, q: e.q, publicQ: e.publicQ || '', a: e.a, chapter: e.chapter || '', lang: e.lang || '' }));
}
/** Approve (true) or hide (false) a stored question for the public panel. Rewrites the JSONL. */
export function setApproval(id, approved) {
  const all = readAll(); let changed = false;
  for (const e of all) if (e.id === id) { e.approved = approved === true ? true : false; changed = true; }
  if (changed) { try { fs.writeFileSync(LOG_PATH, all.map((e) => JSON.stringify(e)).join('\n') + '\n'); } catch { return false; } }
  return changed;
}

/** Newsletter feed: recent PUBLIC questions (optionally since a date / limited) for the
 *  quarterly "new complex questions" digest. Curate from these. */
export function forNewsletter({ sinceISO, limit = 100 } = {}) {
  return readAll().filter(isPublic)
    .filter((e) => !sinceISO || e.ts >= sinceISO)
    .map((e) => ({ ts: e.ts, q: shownQ(e), chapter: e.chapter || '', lang: e.lang || '', clauses: e.clauses || [] })) // public rephrasing only — never raw e.q
    .slice(-limit).reverse();
}

export function stats() {
  const all = readAll();
  return { total: all.length, public: all.filter(isPublic).length };
}
