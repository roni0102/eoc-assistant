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
import { mailAvailable, sendReviewEmail, sendExpertEmail, sendBugEmail } from './mailer.mjs';
import * as qalog from './qalog.mjs';
import * as leads from './leads.mjs';
import * as billing from './billing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const app = express();
app.set('trust proxy', true); // correct https/origin behind Render's proxy
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' })); // Grow callback is form-encoded
app.use(express.static(PUBLIC));

// --- Premium: in-memory upload (never written to disk), license gate, download cache ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => cb(null, /\.xlsx$/i.test(file.originalname) || /spreadsheet/i.test(file.mimetype)),
});

// Attachments (images / PDF) the client adds to a question or to the review. In-memory only.
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'application/pdf']);
const uploadMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 5 }, // 12 MB each, ≤5 files
  fileFilter: (_req, file, cb) => cb(null, MEDIA_TYPES.has(file.mimetype)),
});
const toAttachments = (files) => (files || []).map((f) => ({ media_type: f.mimetype === 'image/jpg' ? 'image/jpeg' : f.mimetype, data: f.buffer.toString('base64'), name: f.originalname }));
// Review upload: the EOC .xlsx + up to 5 supporting media files (drawings/docs the engine can see).
const uploadReview = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'eoc') return cb(null, /\.xlsx$/i.test(file.originalname) || /spreadsheet/i.test(file.mimetype));
    if (file.fieldname === 'supporting') return cb(null, MEDIA_TYPES.has(file.mimetype));
    cb(null, false);
  },
});
// 1 attachment for free accounts, up to 5 for a premium (subscribed) account.
const maxFilesFor = (email) => (billing.hasSub(email) ? 5 : 1);

// Premium gate — fallback used only when Grow billing is NOT configured (see billing.mjs).
// Configure PREMIUM_LICENSE_KEYS=key1,key2 for a manual gate; if unset, premium is OPEN (dev mode).
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

// Validate a stored session token on page load (so the gate shows up front, not mid-query).
app.get('/session', requireGate, (_req, res) => res.json({ ok: true }));

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

// --- Billing (Grow / Meshulam) ---------------------------------------------------------
// Account/entitlement status for the current visitor (drives the UI's pay buttons).
app.get('/me', requireGate, (req, res) => {
  const email = leads.emailForToken(req.sessionToken);
  const ent = billing.entitlements(email);
  res.json({ billing: billing.billingAvailable(), pricing: billing.pricing(), entitlements: ent, admin: !!ent.admin, freeLimit: leads.freeLimit() });
});

// Admin/owner unlock: a correct ADMIN_KEY (env only) grants this email unlimited questions +
// free EOC reviews. The key is never echoed or logged.
app.post('/admin/unlock', rateLimit, requireGate, (req, res) => {
  if (!billing.adminConfigured()) return res.status(503).json({ error: 'Admin access is not configured on this server.' });
  if (!billing.adminKeyValid(req.body?.key)) return res.status(403).json({ error: 'Incorrect admin key.' });
  const email = leads.emailForToken(req.sessionToken);
  billing.grantAdmin(email);
  res.json({ ok: true, admin: true });
});

// User-submitted bug report → leads.jsonl + Google Sheet (persistent) + email (with the optional
// screenshot/file attached). No gate required (a bug may block gating); the session token is used
// only to attach the reporter if present. The file is held in memory and forwarded, never stored.
app.post('/bug', rateLimit, uploadMedia.single('file'), (req, res) => {
  const file = req.file ? { name: req.file.originalname, mimetype: req.file.mimetype, buffer: req.file.buffer } : null;
  const r = leads.recordBug({
    token: req.get('x-session') || '', message: req.body?.message,
    email: req.body?.email, context: req.body?.context, ua: req.get('user-agent'),
    attachmentName: file?.name || '',
  });
  if (!r.ok) return res.status(400).json({ error: r.error });
  if (mailAvailable()) sendBugEmail({ bug: r.entry, file }).catch(() => {});
  res.json({ ok: true });
});

// Start a payment: returns a hosted-checkout URL the browser redirects to.
app.post('/checkout', rateLimit, requireGate, async (req, res) => {
  const kind = String(req.body?.kind || '').trim();
  if (!['review', 'consult', 'subscription', 'questions'].includes(kind)) return res.status(400).json({ error: 'Unknown product.' });
  if (req.body?.policy !== true) return res.status(400).json({ error: 'Please accept the Purchasing Policy & Terms to continue.' });
  // Audit the policy acceptance, linked to the client's email, to leads.jsonl + the Google Sheet.
  leads.recordConsent(req.sessionToken, `checkout: ${kind}`);
  const email = leads.emailForToken(req.sessionToken);
  const origin = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  try {
    const { url } = await billing.createCheckout({ kind, email, origin });
    res.json({ url });
  } catch (e) {
    if (e.code === 'NO_BILLING') return res.status(503).json({ error: 'Payments are not connected yet — please check back soon.' });
    console.error('[checkout] failed:', e?.message || e);
    res.status(502).json({ error: 'Could not start payment. Please try again.' });
  }
});

// Grow server-to-server callback: confirm payment → grant the entitlement.
app.post('/pay/callback', async (req, res) => {
  try {
    const r = await billing.handleCallback(req.body);
    console.log(`[pay] callback ok=${r.ok} kind=${r.kind || '?'}`);
  } catch (e) { console.error('[pay] callback error:', e?.message || e); }
  res.json({ received: true }); // always 200 so the gateway doesn't retry-storm
});

// Book a 30-minute online consultation with a real ITL expert: topic + short description +
// 2-3 proposed times. Paid (consult credit) once billing is live; the credit is consumed on
// SUCCESS, so an invalid form never burns it. Graceful: free until billing is connected.
app.post('/expert', rateLimit, requireGate, (req, res) => {
  const email = leads.emailForToken(req.sessionToken);
  const billed = billing.billingAvailable();
  if (billed && billing.entitlements(email).consults <= 0) {
    return res.status(402).json({ pay: 'consult', error: 'A paid 30-minute consultation is required to book a meeting.' });
  }
  const r = leads.addExpertRequest({
    token: req.sessionToken,
    topic: req.body?.topic, description: req.body?.description, slots: req.body?.slots,
  });
  if (!r.ok) return res.status(400).json({ error: r.error });
  if (billed) billing.useConsult(email); // consume one consult credit on success
  // Email an internal summary to the team (graceful: no-op unless SMTP is configured).
  if (mailAvailable()) sendExpertEmail({ booking: r.entry }).catch(() => {});
  console.log('[expert] consultation booking captured');
  res.json({ ok: true });
});

app.post('/ask', rateLimit, requireGate, uploadMedia.array('files', 5), async (req, res) => {
  const t0 = Date.now();
  const q = String(req.body?.q ?? '').slice(0, 2000).trim();
  if (!q) return res.status(400).json({ error: 'Empty query.' });
  // Free-plan cap (token-spend control). Subscribers skip the cap entirely (unlimited).
  const askEmail = leads.emailForToken(req.sessionToken);
  const subscribed = billing.hasSub(askEmail) || billing.isAdmin(askEmail); // admin = unlimited
  let quota = null;
  if (!subscribed) {
    quota = leads.useQuery(req.sessionToken, billing.extraQuestions(askEmail));
    if (!quota.ok) {
      const on = billing.billingAvailable();
      return res.status(429).json({
        limit: true,
        canSubscribe: on,
        canBuyQuestions: on,
        message: `You've used all ${quota.allowance} of your questions.${on ? ' Buy more questions, subscribe for unlimited, or talk to a real ITL expert.' : ' For more, talk to a real ITL expert.'}`,
      });
    }
  }
  // prior conversation turns sent by the browser (history is a JSON string under multipart)
  let history = req.body?.history;
  if (typeof history === 'string') { try { history = JSON.parse(history); } catch { history = []; } }
  if (!Array.isArray(history)) history = [];
  // attached files (image/PDF): 1 for free, up to 5 for premium. The client's own files —
  // processed in memory only, never stored; the text answer still passes the anonymity guard.
  const attachments = toAttachments((req.files || []).slice(0, maxFilesFor(askEmail)));
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
    if ((answer.covered || attachments.length) && llmAvailable()) {
      try {
        const standard = retrieveStandard(retrievalQ);
        const llm = await answerWithLLM({ query: q, cards: answer.cards, standard, history, attachments });
        answer.covered = true; // an attached file is reviewable even without a clause match
        answer.llm_answer = llm.text;
        answer.llm_model = llm.model;
        answer.attachments = attachments.length;
        answer.standard_sources = [...new Set(standard.map((s) => s.source))];
      } catch (e) {
        if (e.code === 'ANON_BLOCK') console.error('[ask] LLM answer BLOCKED by anonymity guard');
        else console.error('[ask] LLM error:', e.message);
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
    if (quota) answer.free_remaining = quota.remaining; else answer.unlimited = true; // subscribers = unlimited
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
app.post('/review', uploadReview.fields([{ name: 'eoc', maxCount: 1 }, { name: 'supporting', maxCount: 5 }]), requireGate, async (req, res) => {
  const t0 = Date.now();
  if (!llmAvailable()) return res.status(503).json({ error: 'Premium review needs the LLM — set ANTHROPIC_API_KEY.' });
  // Paid review: once billing is live, access requires EITHER an active membership (which
  // INCLUDES the full review) OR a one-time review credit. A credit is consumed on SUCCESS
  // (below) only when not covered by membership, so a failed review never burns it. Until
  // billing is connected, use the license-key gate.
  const revEmail = leads.emailForToken(req.sessionToken);
  const billed = billing.billingAvailable();
  let devMode = false, subCovered = false;
  // Admin/owner bypass: the admin key may be supplied in the license field; once valid this email
  // is flagged admin (persisted) and runs reviews free.
  if (billing.adminKeyValid(req.body?.license)) billing.grantAdmin(revEmail);
  const adminUser = billing.isAdmin(revEmail);
  if (adminUser) {
    subCovered = true; // admin runs reviews free, no credit consumed
  } else if (billed) {
    const ent = billing.entitlements(revEmail);
    subCovered = !!ent.subActive; // membership includes the full EOC review
    if (!subCovered && ent.reviews <= 0) return res.status(402).json({ pay: 'review', error: 'A one-time EOC review (₪87) or a monthly membership (₪97) is required.' });
  } else {
    // Pre-launch TESTING mode: while NOTHING is configured yet (no Grow billing, no ADMIN_KEY, no
    // PREMIUM_LICENSE_KEYS), the review is OPEN so the owner can test it. The paywall switches on
    // AUTOMATICALLY the moment any of those is set — then free users get the payment popup and
    // admin/license holders bypass. A valid license key always grants access.
    const paywallOn = billing.adminConfigured() || LICENSE_KEYS.length > 0;
    const gate = premiumOk(req);
    if (paywallOn && (gate.dev || !gate.ok)) return res.status(402).json({ pay: 'review', error: 'A full EOC review requires a paid plan.' });
    devMode = gate.dev; // mark "open/testing" in the result + log
  }
  const eocFile = req.files?.eoc?.[0];
  if (!eocFile) return res.status(400).json({ error: 'No EOC file uploaded (.xlsx).' });
  const supporting = toAttachments((req.files?.supporting || []).slice(0, 5)); // drawings/docs the engine can see
  try {
    const eoc = await readEOC(eocFile.buffer);
    const detected = eoc.type; // Piping | IAA, from the file's clauses
    const chosen = ['Piping', 'IAA'].includes(String(req.body?.formType)) ? req.body.formType : null;
    const type = chosen || detected; // the client picked an entry point; trust it, flag mismatch
    const mismatch = !!(chosen && chosen !== detected);
    // Scope to the chosen form's chapters: Piping = Chapter 7 only; IAA = Chapters 4–6 only.
    // The client uploads the FULL EOC, but a review is for ONE form — never cross-check the other.
    const ch = (c) => parseInt(String(c).split('.')[0], 10);
    const inScope = type === 'Piping'
      ? (c) => ch(c) === 7 // Piping = Chapter 7 only
      : (c) => ch(c) >= 4 && ch(c) !== 7; // IAA = Ch 4–6 + appliance chapters (e.g. 21), never piping
    const scoped = eoc.rows.filter((r) => r.clause && inScope(r.clause));
    if (!scoped.length) {
      return res.status(400).json({ error: `No ${type === 'Piping' ? 'Chapter 7 (Piping)' : 'Chapter 4–6 (IAA appliance)'} lines were found in this file${detected !== type ? ` — it looks like a ${detected} EOC, so switch the type above and re-run` : ''}.` });
    }
    const answered = scoped.filter((r) => r.answered).length;
    // Default: review the WHOLE form. An optional cap (req.body.limit or REVIEW_MAX_ROWS) only
    // applies if explicitly set; streaming keeps the connection alive for large forms.
    const reqLimit = parseInt(req.body?.limit || '', 10) || parseInt(process.env.REVIEW_MAX_ROWS || '', 10) || 0;
    const limit = reqLimit ? Math.min(reqLimit, 5000) : undefined;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // ask proxies not to buffer the stream
    const writeLine = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch {} };
    writeLine({ progress: { done: 0, total: limit ? Math.min(answered, limit) : answered } });
    const report = await reviewEOC({ type, rows: scoped, limit, attachments: supporting, onProgress: (done, total) => writeLine({ progress: { done, total } }) });
    const annotated = await writeEOC(eocFile.buffer, report.updates);
    const token = cacheDownload(annotated, `EOC-${type}-review.xlsx`);
    if (billed && !subCovered) billing.useReview(revEmail); // consume a credit only if membership didn't cover it
    leads.markTier(req.sessionToken, 'premium'); // record that this lead used premium
    const sb = report.scoreboard;
    // Email a copy to the client (graceful: no-op unless SMTP is configured).
    let emailed = false;
    const to = leads.emailForToken(req.sessionToken);
    if (mailAvailable()) emailed = await sendReviewEmail({ to, type, scoreboard: sb, attachment: annotated, filename: `EOC-${type}-review.xlsx` });
    console.log(`[review] type=${type} detected=${detected} scope=${scoped.length} assessed=${sb.assessed} requirements=${sb.requirements} structural=${sb.structural} notReviewed=${sb.not_reviewed} emailed=${emailed} dev=${devMode} ms=${Date.now() - t0}`);
    writeLine({ result: {
      type, detected_type: detected, type_mismatch: mismatch,
      sheet: eoc.sheetName,
      answered_rows: answered,
      assessed: sb.assessed, requirements: sb.requirements, structural: sb.structural,
      not_reviewed: sb.not_reviewed, total_rows: sb.total,
      capped: sb.not_reviewed > 0,
      scoreboard: sb,
      items: report.items,
      download_token: token,
      emailed, email_to: emailed ? to : '',
      dev_mode: devMode,
      disclaimer: 'Reference guidance only — not a formal ITL determination, and it does not see your actual attached documents/drawings. Final approval is subject to ITL review of the actual submission. Your uploaded EOC was processed in memory only and was not stored.',
    } });
    res.end();
  } catch (err) {
    console.error('[review] error', err.message);
    if (res.headersSent) { try { res.write(JSON.stringify({ error: 'The review failed partway through — please try again.' }) + '\n'); } catch {} res.end(); }
    else res.status(500).json({ error: 'Could not review this EOC. Is it a valid SI 6464 EOC .xlsx (with a Report Body sheet)?' });
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
