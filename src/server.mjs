// server.mjs — backend (Deliverable #4) + serves the search UI (#5).
//
//   GET  /            -> the search page (public/index.html)
//   GET  /healthz     -> liveness
//   POST /ask {q}     -> grounded, anonymous answer card(s)
//
// The LLM API key (when added) stays server-side only. Queries are rate-limited
// and logged WITHOUT anything client-identifying.
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { retrieve, retrieveStandard, loadKB, loadStandard } from './retrieve.mjs';
import { composeAnswer } from './answer.mjs';
import { answerWithLLM, translate, LANG_NAMES, llmAvailable, MODEL } from './llm.mjs';
import { readEOC, writeEOC } from './eoc.mjs';
import { reviewEOC } from './review.mjs';
import * as qalog from './qalog.mjs';
import * as leads from './leads.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(PUBLIC));

// --- Premium: in-memory upload (never written to disk), license gate, download cache ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => cb(null, /\.xlsx$/i.test(file.originalname) || /spreadsheet/i.test(file.mimetype)),
});

// Premium gate. Configure PREMIUM_LICENSE_KEYS=key1,key2 (or wire Stripe here). If unset,
// premium is OPEN (dev mode) and the response flags it.
const LICENSE_KEYS = (process.env.PREMIUM_LICENSE_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
function premiumOk(req) {
  if (!LICENSE_KEYS.length) return { ok: true, dev: true };
  const key = req.get('x-license-key') || req.body?.license || '';
  return { ok: LICENSE_KEYS.includes(key), dev: false };
}

// One-time, in-memory download cache for annotated EOCs (TTL; never touches disk).
const downloads = new Map(); // token -> { buffer, name, exp }
function cacheDownload(buffer, name) {
  const token = crypto.randomBytes(16).toString('hex');
  downloads.set(token, { buffer, name, exp: Date.now() + 15 * 60_000 });
  return token;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of downloads) if (v.exp < now) downloads.delete(k); }, 60_000).unref?.();

// --- minimal in-memory rate limit (per IP, sliding window) ----------------------
const WINDOW_MS = 60_000, MAX = 30;
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX) return res.status(429).json({ error: 'Too many requests — please slow down.' });
  arr.push(now); hits.set(ip, arr);
  next();
}

// Entry gate: /ask and /review require a session token issued by /lead, so the
// lead-capture gate cannot be bypassed by calling the API directly.
function requireGate(req, res, next) {
  const token = req.get('x-session') || req.body?.session || '';
  if (!leads.validToken(token)) return res.status(401).json({ gate: true, error: 'Please provide your details to continue.' });
  req.sessionToken = token;
  next();
}

// Query log: length + mode + latency only. No query text, no IP, no PII.
function logQuery(meta) {
  console.log(`[ask] qlen=${meta.qlen} mode=${meta.mode} covered=${meta.covered} llm=${meta.llm} ms=${meta.ms}`);
}

app.get('/healthz', (_req, res) => res.json({ ok: true, lines: loadKB().items.length }));

// Lead-capture entry gate: store the visitor's contact details, unlock the session.
app.post('/lead', rateLimit, (req, res) => {
  const { email, phone, company } = req.body || {};
  const r = leads.addLead({ email, phone, company });
  if (!r.ok) return res.status(400).json({ error: r.error });
  console.log(`[lead] new lead captured (company len=${String(company).length})`);
  res.json({ ok: true, token: r.token });
});

// Admin export of captured leads (CSV). Protected by LEADS_ADMIN_KEY (?key= or header).
app.get('/leads/export', (req, res) => {
  const adminKey = process.env.LEADS_ADMIN_KEY;
  if (!adminKey) return res.status(403).send('Leads export disabled — set LEADS_ADMIN_KEY to enable.');
  if ((req.get('x-admin-key') || req.query.key) !== adminKey) return res.status(403).send('Forbidden.');
  const csv = leads.toCSV(leads.allLeads());
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="eoc-leads.csv"');
  res.send(csv);
});

// Shared, anonymized Q&A — questions other clients have asked (a growing FAQ).
app.get('/qa/recent', rateLimit, (req, res) => {
  const q = String(req.query?.q ?? '').trim();
  const items = q ? qalog.search(q, 12) : qalog.recent(20);
  res.json({ items, total: qalog.stats().total });
});

// Translate an answer to Hebrew or Russian on demand (per-answer toggle in the UI).
app.post('/translate', rateLimit, requireGate, async (req, res) => {
  const text = String(req.body?.text ?? '').slice(0, 8000).trim();
  const lang = String(req.body?.lang ?? 'he').trim();
  if (!text) return res.status(400).json({ error: 'Nothing to translate.' });
  if (!LANG_NAMES[lang]) return res.status(400).json({ error: 'Unsupported language.' });
  if (!llmAvailable()) return res.status(503).json({ error: 'Translation needs the LLM — set ANTHROPIC_API_KEY.' });
  try {
    const r = await translate(text, lang);
    res.json({ text: r.text, lang });
  } catch (e) {
    console.error('[translate] failed:', e?.message || e);
    res.status(500).json({ error: 'Could not translate right now — please try again.' });
  }
});

app.post('/ask', rateLimit, requireGate, async (req, res) => {
  const t0 = Date.now();
  const q = String(req.body?.q ?? '').slice(0, 2000).trim();
  if (!q) return res.status(400).json({ error: 'Empty query.' });
  // prior conversation turns sent by the browser (stateless backend)
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  // Keep follow-ups on-topic: blend the previous question into the retrieval query so a
  // context-dependent follow-up ("and what does the IB ask for?") still surfaces the same
  // clause. The current question's own terms still carry weight, so a clear topic change
  // ("now tell me about HAZOP", "is it different for a steam boiler?") still shifts focus.
  const lastUser = [...history].reverse().find((h) => h?.role === 'user' && typeof h.content === 'string');
  const retrievalQ = lastUser ? `${lastUser.content} ${q}` : q;
  try {
    const retrieved = retrieve(retrievalQ);
    const answer = composeAnswer({ query: q, retrieved });
    // LLM layer: when a key is configured, Claude writes a grounded, anonymous
    // natural-language answer from the (already-anonymized) retrieved cards.
    if (answer.covered && llmAvailable()) {
      try {
        const standard = retrieveStandard(retrievalQ);
        const llm = await answerWithLLM({ query: q, cards: answer.cards, standard, history });
        answer.llm_answer = llm.text;
        answer.llm_model = llm.model;
        answer.standard_sources = [...new Set(standard.map((s) => s.source))];
      } catch (e) {
        if (e.code === 'ANON_BLOCK') console.error('[ask] LLM answer BLOCKED by anonymity guard');
        else console.error('[ask] LLM error:', e.message);
        // TEMP DIAGNOSTIC (no raw text): why did the LLM answer not show?
        answer._llmfail = e.code || e.name || 'error';
        answer._llmwhy = e.code === 'ANON_BLOCK' ? e.hitTypes : String(e.message || '').slice(0, 140);
        answer._llmsamples = e.matchedSamples; // TEMP diag only
        // fall back to the deterministic card (answer already has it)
      }
    }
    logQuery({ qlen: q.length, mode: retrieved.mode, covered: answer.covered, llm: !!answer.llm_answer, ms: Date.now() - t0 });
    // Record the (anonymized) Q&A so it can be shared with other clients as a growing FAQ.
    if (answer.covered) {
      qalog.record({
        question: q,
        answer: answer.llm_answer || (answer.cards?.[0]?.requirement || ''),
        clauses: (answer.cards || []).map((c) => c.clause).filter(Boolean),
        tier: 'free',
      });
    }
    res.json(answer);
  } catch (err) {
    if (err.code === 'ANON_BLOCK') {
      // Fail closed: never leak. Log the block (without the offending text).
      console.error('[ask] BLOCKED by anonymity guard');
      return res.status(500).json({ error: 'Answer withheld by the anonymity guard.' });
    }
    console.error('[ask] error', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// --- Premium: full-EOC review (Deliverable: the eoc-fill engine, server-side) ----------
// Upload a filled EOC -> ITL-style line-by-line review. The file is processed in memory
// only; it is never persisted and never added to the public knowledge base.
app.post('/review', upload.single('eoc'), requireGate, async (req, res) => {
  const t0 = Date.now();
  if (!llmAvailable()) return res.status(503).json({ error: 'Premium review needs the LLM — set ANTHROPIC_API_KEY.' });
  const gate = premiumOk(req);
  if (!gate.ok) return res.status(402).json({ error: 'Premium feature — a valid license key is required.' });
  if (!req.file) return res.status(400).json({ error: 'No EOC file uploaded (.xlsx).' });
  try {
    const eoc = await readEOC(req.file.buffer);
    const answered = eoc.rows.filter((r) => r.answered).length;
    // Optional cap (transparent) so a huge EOC doesn't hit the request timeout.
    const limit = Math.min(parseInt(req.body?.limit || '', 10) || (parseInt(process.env.REVIEW_MAX_ROWS || '', 10) || 50), 400);
    const report = await reviewEOC({ type: eoc.type, rows: eoc.rows, limit });
    const annotated = await writeEOC(req.file.buffer, report.updates);
    const token = cacheDownload(annotated, `EOC-reviewed-${Date.now()}.xlsx`);
    leads.markTier(req.sessionToken, 'premium'); // record that this lead used premium
    const reviewedCount = report.items.filter((i) => i.verdict && i.verdict !== 'MISSING').length;
    console.log(`[review] type=${eoc.type} rows=${eoc.rows.length} answered=${answered} reviewed=${reviewedCount} dev=${gate.dev} ms=${Date.now() - t0}`);
    res.json({
      type: eoc.type,
      sheet: eoc.sheetName,
      total_item_rows: eoc.rows.length,
      answered_rows: answered,
      reviewed_rows: reviewedCount,
      capped: answered > limit,
      cap: limit,
      scoreboard: report.scoreboard,
      items: report.items,
      download_token: token,
      dev_mode: gate.dev,
      disclaimer: 'Reference guidance only — not a formal ITL determination. Final approval is subject to ITL review of the actual submission. Your uploaded EOC was processed in memory only and was not stored.',
    });
  } catch (err) {
    console.error('[review] error', err.message);
    res.status(500).json({ error: 'Could not review this EOC. Is it a valid SI 6464 EOC .xlsx (with a Report Body sheet)?' });
  }
});

app.get('/review/download/:token', (req, res) => {
  const d = downloads.get(req.params.token);
  if (!d || d.exp < Date.now()) return res.status(404).send('Download expired or not found.');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${d.name}"`);
  res.send(d.buffer);
  downloads.delete(req.params.token); // one-time
});

app.listen(PORT, () => {
  loadKB();
  const std = loadStandard().chunks?.length || 0;
  const llm = llmAvailable() ? `LLM ON (${MODEL})` : 'LLM OFF (set ANTHROPIC_API_KEY) — deterministic cards';
  console.log(`ITL EOC Assistant backend on http://localhost:${PORT}  (${loadKB().items.length} clauses, ${std} SI 6464 passages) · ${llm}`);
});
