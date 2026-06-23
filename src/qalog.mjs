// qalog.mjs — persistent, ANONYMIZED Q&A log.
//
// Every free-tier question + answer is recorded so the accumulated knowledge can be
// shared with other clients (a growing FAQ). The asker's question is SCRUBBED before
// it is stored, because a question may contain the asker's own client/site name — and
// what we store here is shown to OTHER clients. The answer is already generic/anonymous
// (it passed the answer guard). Premium EOC uploads are NEVER logged here.
//
// Storage: append-only JSONL (data/qa_log.jsonl). Simple, durable, no native deps.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scrub, scanAnswer } from './anonymize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Runtime data dir — override with DATA_DIR (e.g. a Render persistent disk).
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
const LOG_PATH = path.join(DATA_DIR, 'qa_log.jsonl');

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * record({ question, answer, clauses, tier }): scrub the question, keep the (already
 * anonymous) answer, append a line. Fire-and-forget; never throws into the request path.
 */
export function record({ question, answer, clauses, tier }) {
  try {
    const q = scrub(norm(question)).slice(0, 600);
    if (!q || q.replace(/\[[^\]]+\]/g, '').replace(/[^\p{L}\p{N}]/gu, '').length < 4) return; // nothing useful left
    // belt-and-suspenders: never store an answer that still trips the guard
    const a = scanAnswer(answer || '').length ? '' : norm(answer).slice(0, 4000);
    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      ts: new Date().toISOString(),
      tier: tier || 'free',
      q, a,
      clauses: Array.isArray(clauses) ? clauses.slice(0, 6) : [],
    };
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  } catch { /* logging must never break answering */ }
}

function readAll() {
  try {
    return fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** recent(limit): most-recent distinct questions (deduped), newest first. */
export function recent(limit = 20) {
  const all = readAll();
  const seen = new Set(), out = [];
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    const e = all[i];
    const key = e.q.toLowerCase();
    if (seen.has(key) || !e.a) continue; // skip dups + answer-less entries
    seen.add(key);
    out.push({ id: e.id, ts: e.ts, q: e.q, a: e.a, clauses: e.clauses });
  }
  return out;
}

/** search(query, limit): lexical match over stored questions + answers. */
export function search(query, limit = 10) {
  const terms = norm(query).toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!terms.length) return recent(limit);
  const all = readAll();
  const scored = all.map((e) => {
    const hay = (e.q + ' ' + (e.a || '')).toLowerCase();
    let s = 0; for (const t of terms) if (hay.includes(t)) s++;
    return { e, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const seen = new Set(), out = [];
  for (const { e } of scored) { const k = e.q.toLowerCase(); if (seen.has(k) || !e.a) continue; seen.add(k); out.push({ id: e.id, ts: e.ts, q: e.q, a: e.a, clauses: e.clauses }); if (out.length >= limit) break; }
  return out;
}

export function stats() { return { total: readAll().length }; }
