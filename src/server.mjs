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
import { answerWithLLM, translate, LANG_NAMES, llmAvailable, MODEL, genericizeQuestion } from './llm.mjs';
import { readEOC, writeEOC } from './eoc.mjs';
import { reviewEOC } from './review.mjs';
import { mailAvailable, sendReviewEmail, sendExpertEmail, sendBugEmail, sendRenewalReminder, sendVerificationCode } from './mailer.mjs';
import * as qalog from './qalog.mjs';
import * as leads from './leads.mjs';
import * as billing from './billing.mjs';
import * as morning from './morning.mjs';

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
const WINDOW_MS = 60_000, MAX = 30, HITS_CAP = 20_000;
const hits = new Map();
// Client IP: Render fronts every request with Cloudflare, which sets `cf-connecting-ip` to the real
// client and overwrites any client-supplied value — so it can't be spoofed to bypass the limit
// (unlike the leftmost X-Forwarded-For that `trust proxy: true` exposes via req.ip). Fall back to
// req.ip for local/dev.
const clientIp = (req) => req.headers['cf-connecting-ip'] || req.headers['true-client-ip'] || req.ip || 'unknown';
// Constant-time secret comparison (defense-in-depth against timing attacks on admin keys).
const safeEqual = (a, b) => { a = String(a ?? ''); b = String(b ?? ''); if (a.length !== b.length || !a) return false; try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; } };
function rateLimit(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX) return res.status(429).json({ error: 'Too many requests — please slow down.' });
  arr.push(now); hits.set(ip, arr);
  // Bound memory: if the map grows huge (spoofed/rotating IPs, or just scale), drop stale entries.
  if (hits.size > HITS_CAP) for (const [k, v] of hits) { if (!v.length || now - v[v.length - 1] >= WINDOW_MS) hits.delete(k); }
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

// Liveness probe — must respond instantly (no KB load) so the platform health check passes
// even during a cold start, otherwise the deploy times out waiting on it. Reports the data
// directory (non-sensitive) to confirm the persistent disk is wired.
app.get('/healthz', (_req, res) => res.json({ ok: true, dataDir: process.env.DATA_DIR || '(default ./data)' }));

// Legal / contact pages (clean URLs) + the Purchasing Policy served explicitly as a real file,
// so the links work even behind a custom domain / proxy (never caught by any SPA fallback).
app.get('/accessibility', (_req, res) => res.sendFile(path.join(PUBLIC, 'accessibility.html')));
app.get('/contact', (_req, res) => res.sendFile(path.join(PUBLIC, 'contact.html')));
app.get(['/purchasing-policy.pdf', '/terms'], (_req, res) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="purchasing-policy.pdf"');
  res.sendFile(path.join(PUBLIC, 'purchasing-policy.pdf'));
});

// Validate a stored session token on page load (so the gate shows up front, not mid-query).
app.get('/session', requireGate, (_req, res) => res.json({ ok: true }));

// Email verification — required before PAID access, so a session can't spend entitlements bought
// under an email it doesn't control. A 6-digit code is emailed to the SESSION's email; entering it
// marks THIS token verified. The code value is never returned in the API.
const maskEmail = (e) => String(e || '').replace(/^(.).*(.@.*)$/, '$1***$2');
app.post('/verify/start', rateLimit, requireGate, async (req, res) => {
  if (!mailAvailable()) return res.status(503).json({ error: 'Email is not configured — verification is unavailable.' });
  const r = leads.startVerification(req.sessionToken);
  if (!r.ok) return res.status(400).json({ error: r.error });
  const sent = await sendVerificationCode({ to: r.email, code: r.code }).catch(() => false);
  if (!sent) return res.status(502).json({ error: 'Could not send the code — please try again.' });
  console.log(`[verify] code sent to ${maskEmail(r.email)}`);
  res.json({ sent: true, email: maskEmail(r.email) });
});
app.post('/verify/confirm', rateLimit, requireGate, (req, res) => {
  const r = leads.confirmVerification(req.sessionToken, req.body?.code);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, verified: true });
});

// TEMP go-live diagnostic (gated by the webhook secret) — confirms the ENV, that the keys
// authenticate, and that payment-link creation works on production (no secret echoed).
app.get('/paydiag', async (req, res) => {
  if (req.query.k !== process.env.GREENINVOICE_WEBHOOK_SECRET) return res.status(403).json({ error: 'forbidden' });
  const out = { env: morning.env(), base: morning.baseUrl(), authOk: false, hasPluginEnv: !!process.env.GREENINVOICE_PLUGIN_ID };
  let token;
  try { token = await morning.getToken(); out.authOk = true; } catch (e) { out.authErr = String(e?.message || e).slice(0, 200); return res.json(out); }
  const p = billing.pricing();
  const baseBody = { description: 'EOC Assistant — go-live diag', type: 320, lang: 'he', currency: 'ILS', vatType: 0, amount: p.incl.questions, maxPayments: 1,
    client: { name: 'Diag Test', emails: ['diag@test.co'], add: false },
    income: [{ description: 'q', quantity: 1, price: p.incl.questions, currency: 'ILS', vatType: 1 }],
    successUrl: 'https://eoc-assistant.onrender.com/?paid=questions', failureUrl: 'https://eoc-assistant.onrender.com/?canceled=1', notifyUrl: 'https://eoc-assistant.onrender.com/pay/callback' };
  const tryForm = async (extra) => {
    try {
      const r = await fetch(morning.baseUrl() + 'payments/form', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...baseBody, ...extra }) });
      const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {}
      return j.url ? '✅ URL' : `${r.status} err${j.errorCode}:${(j.errorMessage || t).slice(0, 60)}`;
    } catch (e) { return 'ERR ' + String(e?.message || e).slice(0, 60); }
  };
  out.withSandboxPlugin = process.env.GREENINVOICE_PLUGIN_ID ? await tryForm({ pluginId: process.env.GREENINVOICE_PLUGIN_ID }) : 'n/a';
  out.noPlugin = await tryForm({});
  // Probe for a listable payment plugin/terminal id on the account.
  const tryGet = async (path) => {
    try { const r = await fetch(morning.baseUrl() + path, { headers: { Authorization: `Bearer ${token}` } }); const t = await r.text(); return `${r.status}: ${t.slice(0, 220)}`; }
    catch (e) { return 'ERR ' + String(e?.message || e).slice(0, 60); }
  };
  out.plugins = {};
  for (const path of ['payments/plugins', 'payments/gateways', 'payments', 'account/plugins', 'payment/plugins']) out.plugins[path] = await tryGet(path);
  res.json(out);
});

// Lead-capture entry gate: store the visitor's contact details, unlock the session.
app.post('/lead', rateLimit, (req, res) => {
  const { email, phone, company, light } = req.body || {};
  const r = leads.addLead({ email, phone, company, light: !!light });
  if (!r.ok) return res.status(400).json({ error: r.error });
  console.log(`[lead] new ${light ? 'light ' : ''}lead captured (tier=free)`);
  res.json({ ok: true, token: r.token });
});

// Admin export of captured leads (CSV). Protected by LEADS_ADMIN_KEY (?key= or header).
app.get('/leads/export', (req, res) => {
  const adminKey = process.env.LEADS_ADMIN_KEY;
  if (!adminKey) return res.status(403).send('Leads export disabled — set LEADS_ADMIN_KEY to enable.');
  if (!safeEqual(req.get('x-admin-key') || req.query.key, adminKey)) return res.status(403).send('Forbidden.'); // prefer the x-admin-key HEADER (a ?key= is logged by proxies)
  const csv = leads.toCSV(leads.allLeads());
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="eoc-leads.csv"');
  res.send(csv);
});

// Shared, anonymized Q&A — questions other clients have asked (a growing FAQ). Only
// publicly-eligible (auto-anonymized or admin-approved) entries are returned.
app.get('/qa/recent', rateLimit, (req, res) => {
  const q = String(req.query?.q ?? '').trim();
  const items = q ? qalog.search(q, 12) : qalog.recent(20);
  res.json({ items, total: qalog.stats().public });
});

// Admin-only curation of the public Q&A panel (manual approve/hide). Gated by the admin key —
// lets the owner promote a redacted-but-safe question, or hide one. No-op unless ADMIN_KEY is set.
app.get('/qa/pending', rateLimit, (req, res) => {
  if (!billing.adminKeyValid(req.get('x-admin-key'))) return res.status(403).json({ error: 'forbidden' });
  res.json({ items: qalog.pending(50) });
});
app.post('/qa/moderate', rateLimit, (req, res) => {
  if (!billing.adminKeyValid(req.get('x-admin-key'))) return res.status(403).json({ error: 'forbidden' });
  const ok = qalog.setApproval(String(req.body?.id || ''), req.body?.approved === true);
  res.json({ ok });
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
// Public account/pricing status. Works WITHOUT a session (pricing is public so the Pricing tab
// renders for brand-new visitors); entitlements/email/admin are included only when gated.
app.get('/me', (req, res) => {
  const token = req.get('x-session') || '';
  const gated = leads.validToken(token);
  const email = gated ? leads.emailForToken(token) : '';
  const ent = email ? billing.entitlements(email) : {};
  // Remaining FREE questions for the returning visitor (read-only — never consumes one). Paid
  // perks only count when the session is verified, mirroring the /ask logic.
  const verified = gated && leads.isVerified(token);
  const unlimited = !!(verified && (ent.subActive || ent.admin));
  const freeRemaining = (gated && !unlimited) ? leads.quotaFor(token, verified ? billing.extraQuestions(email) : 0).remaining : null;
  res.json({ billing: billing.billingAvailable(), pricing: billing.pricing(), entitlements: ent, admin: !!ent.admin, email: email || '', gated, verified, unlimited, freeRemaining, freeLimit: leads.freeLimit() });
});

// Admin/owner unlock: a correct ADMIN_KEY (env only) grants this email unlimited questions +
// free EOC reviews. The key is never echoed or logged.
app.post('/admin/unlock', rateLimit, requireGate, (req, res) => {
  if (!billing.adminConfigured()) return res.status(503).json({ error: 'Admin access is not configured on this server.' });
  if (!billing.adminKeyValid(req.body?.key)) return res.status(403).json({ error: 'Incorrect admin key.' });
  const email = leads.emailForToken(req.sessionToken);
  billing.grantAdmin(email);
  leads.markVerified(req.sessionToken); // correct admin key = proof of identity → verify the session so admin perks apply
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

const PRODUCT_DESC = {
  subscription: 'EOC Assistant — monthly membership (unlimited questions + full EOC review)',
  questions: 'EOC Assistant — one question',
  review: 'EOC Assistant — full EOC review',
  consult: 'EOC Assistant — 30-minute expert consultation',
};

// Start a payment via Morning: collect + validate customer details + terms, capture the lead,
// create the hosted payment page (VAT-inclusive), and remember the pending payment so the webhook
// can grant the right entitlement. Returns the payment URL for the browser to redirect to.
app.post('/checkout', rateLimit, requireGate, async (req, res) => {
  const kind = String(req.body?.kind || '').trim();
  if (!['review', 'consult', 'subscription', 'questions'].includes(kind)) return res.status(400).json({ error: 'Unknown product.' });
  if (req.body?.policy !== true) return res.status(400).json({ error: 'Please accept the Purchasing Policy & Terms to continue.' });
  // The buyer must have VERIFIED their email — the entitlement is granted to (and later used from)
  // this session's email, so we require proof of control before taking money for it.
  if (!leads.isVerified(req.sessionToken)) return res.status(403).json({ verify: true, error: 'Please verify your email before paying.' });
  // Customer details collected before payment (Israeli consumer-protection requirement).
  const cu = req.body?.customer || {};
  const customer = {
    firstName: String(cu.firstName || '').slice(0, 40).trim(),
    lastName: String(cu.lastName || '').slice(0, 40).trim(),
    phone: String(cu.phone || '').replace(/[^\d]/g, '').slice(0, 15),
    country: String(cu.country || '').slice(0, 40).trim(),
    company: String(cu.company || '').slice(0, 80).trim(),
    // Force the payment/invoice/grant email to the VERIFIED session email, so what's bought can
    // only be used by this verified session (a typed-in different address can't redirect the grant).
    email: leads.emailForToken(req.sessionToken) || String(cu.email || '').slice(0, 160).trim(),
  };
  if (!customer.firstName || !customer.lastName) return res.status(400).json({ error: 'Please enter your first and last name.' });
  if (customer.phone.length < 7) return res.status(400).json({ error: 'Please enter a valid phone number.' });
  if (!customer.country) return res.status(400).json({ error: 'Please select your country.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(customer.email)) return res.status(400).json({ error: 'Please enter a valid email.' });
  if (!morning.paymentsConfigured()) return res.status(503).json({ error: 'Payments are not connected yet — please check back soon.' });
  // Capture the lead (email + phone + company) and audit the policy acceptance + buyer details
  // → leads.jsonl + Google Sheet. (The gate already stored the lead; this records the buyer too.)
  leads.addLead({ email: customer.email, phone: customer.phone || '0000000', company: customer.company || `${customer.firstName} ${customer.lastName}` });
  leads.recordConsent(req.sessionToken, `checkout: ${kind} · ${customer.firstName} ${customer.lastName} · ${customer.company || '-'} · ${customer.phone} · ${customer.country} · ${customer.email}`);

  const pricing = billing.pricing();
  const amountIncl = pricing.incl[kind];
  const amountEx = pricing.ex[kind];
  const origin = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  try {
    const { url, id } = await morning.createPaymentForm({
      kind, description: PRODUCT_DESC[kind] || kind, amountIncl, amountEx, client: customer,
      recurring: kind === 'subscription', origin,
    });
    if (!url) return res.status(502).json({ error: 'Could not start payment. Please try again.' });
    // Remember what was bought so the webhook grants the right entitlement (keyed by Morning id + email).
    billing.addPending(id || customer.email, { email: customer.email, kind });
    res.json({ url });
  } catch (e) {
    console.error('[checkout] morning failed:', e?.message || e);
    res.status(502).json({ error: 'Could not start payment right now. Please try again.' });
  }
});

// Morning webhook (server-to-server). Entitlement is granted ONLY here, after the payment is
// confirmed — never on the client-side success redirect. Authenticity is verified via the shared
// secret (Morning Webhooks tab) and, when possible, by re-fetching the document from Morning.
app.post('/pay/callback', rateLimit, async (req, res) => {
  res.json({ received: true }); // ack immediately so Morning doesn't retry-storm
  try {
    const b = req.body || {};
    // Morning (GreenInvoice/2.1) does NOT send a shared secret or signature on the webhook — the
    // body only carries the document id. So authenticity is established by RE-FETCHING the document
    // from Morning's authenticated API: only our own API key can read our documents, and the grant
    // is tied to the email ON that document, so a forged webhook can't redirect credits to anyone.
    const docId = b.id || b.document_id || b.documentId;
    if (!docId) { console.warn('[pay] webhook: no document id in payload'); return; }
    // Replay guard: each Morning document grants at most once, ever. Stops re-POSTing a real
    // (still-valid) invoice id to this unauthenticated endpoint from claiming pending after pending.
    if (billing.isDocProcessed(docId)) { console.log(`[pay] webhook: doc ${docId} already processed, ignoring replay`); return; }
    // Authenticity: re-fetch the document from Morning (only our API key can read our docs). Retry a
    // few times so a TRANSIENT failure doesn't permanently lose a paid grant (we already 200'd, so
    // Morning won't retry us). If it never verifies, we leave the pending unclaimed for recovery.
    let doc = null;
    for (let attempt = 0; attempt < 3 && !doc; attempt++) {
      try { doc = await morning.getDocument(docId); }
      catch (e) { console.warn(`[pay] webhook: getDocument ${docId} attempt ${attempt + 1} failed: ${e?.message || e}`); await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
    }
    if (!doc) { console.error(`[pay] webhook: doc ${docId} could not be verified after retries — NOT granting (pending left for reconciliation)`); return; }
    // A type-320 (tax invoice + receipt) with status 1 (active, not cancelled) = payment received.
    if (String(doc.type) !== '320' || Number(doc.status) !== 1) {
      console.log(`[pay] webhook: doc ${docId} not a valid paid 320 (type=${doc.type} status=${doc.status}), ignoring`); return;
    }
    const email = (doc.client?.emails?.[0] || '').toLowerCase();
    if (!email) { console.warn(`[pay] webhook: doc ${doc.number} has no client email`); return; }
    // Grant is driven by what was ACTUALLY PAID (the document amount → product kind), NOT by the
    // fragile email-keyed pending (which a later checkout overwrites). This prevents paying ₪6 and
    // being granted the ₪673 consult (or vice-versa).
    const kind = billing.kindForAmount(doc.amount);
    if (!kind) { console.error(`[pay] webhook: doc ${doc.number} amount ₪${doc.amount} matches no product price — NOT granting`); return; }
    billing.markDocProcessed(docId);              // consume BEFORE grant so a concurrent replay can't double-grant
    billing.grant(email, kind);
    const f = billing.findPending({ email, kind }); if (f) billing.takePending(f.id); // clean up the matching pending
    console.log(`[pay] ✓ payment confirmed (doc ${doc.number}, ₪${doc.amount}) → granted ${kind} to ${email}`);
  } catch (e) { console.error('[pay] webhook error:', e?.message || e); }
});

// Book a 30-minute online consultation with a real ITL expert: topic + short description +
// 2-3 proposed times. Paid (consult credit) once billing is live; the credit is consumed on
// SUCCESS, so an invalid form never burns it. Graceful: free until billing is connected.
app.post('/expert', rateLimit, requireGate, (req, res) => {
  const email = leads.emailForToken(req.sessionToken);
  const billed = billing.billingAvailable();
  // A consult credit is only honored for a verified session (else it's spoofable via someone else's email).
  const consults = leads.isVerified(req.sessionToken) ? billing.entitlements(email).consults : 0;
  if (billed && consults <= 0) {
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

// NB: /ask is NOT gated on entry. A brand-new device gets ONE free, ungated question (value
// first). After that, a light email gate (no phone) is required; gated users then have the
// per-email free cap (subscribers/admin = unlimited).
app.post('/ask', rateLimit, uploadMedia.array('files', 5), async (req, res) => {
  const t0 = Date.now();
  const q = String(req.body?.q ?? '').slice(0, 2000).trim();
  if (!q) return res.status(400).json({ error: 'Empty query.' });
  const token = req.get('x-session') || req.body?.session || '';
  const gated = leads.validToken(token);
  let askEmail = '', subscribed = false, quota = null, introFree = false;
  if (gated) {
    req.sessionToken = token;
    askEmail = leads.emailForToken(token);
    const paidOk = leads.isVerified(token); // paid perks require a verified email
    subscribed = paidOk && (billing.hasSub(askEmail) || billing.isAdmin(askEmail)); // admin = unlimited
    if (!subscribed) {
      quota = leads.useQuery(token, paidOk ? billing.extraQuestions(askEmail) : 0);
      if (!quota.ok) {
        const on = billing.billingAvailable();
        return res.status(429).json({
          limit: true, canSubscribe: on, canBuyQuestions: on,
          message: `You've used all ${quota.allowance} of your ${quota.allowance === quota.limit ? 'free ' : ''}questions.${on ? ' Buy more questions, subscribe for unlimited, or talk to a certified inspection body expert.' : ' For more, talk to a certified inspection body expert.'}`,
        });
      }
    }
  } else {
    // Brand-new visitor: one free ungated question, then the light email gate. Keyed by the
    // spoof-proof client IP (cf-connecting-ip) — NOT the client-supplied x-device header, which a
    // script could rotate for unlimited free LLM answers.
    const fa = leads.useFreeAsk(clientIp(req));
    if (!fa.ok) return res.status(401).json({ gate: 'light', error: 'Add your email to keep asking — it stays free.' });
    introFree = true;
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
    if (introFree) answer.free_intro = true;            // ungated freebie used → client gates next ask
    else if (quota) answer.free_remaining = quota.remaining;
    else answer.unlimited = true;                        // subscribers/admin = unlimited
    res.json(answer);
    // Record the (anonymized) Q&A so it can be shared with other clients as a growing FAQ — AFTER
    // responding, so the extra rephrasing call never delays the client's answer. The client's own
    // wording is stored only scrubbed/internally; the PUBLIC panel shows `publicQ`, an LLM-made
    // generic, de-identified rephrasing (''=can't generalize safely → kept internal, not shown).
    if (answer.covered) {
      const ans = answer.llm_answer || (answer.cards?.[0]?.requirement || '');
      const clauses = (answer.cards || []).map((c) => c.clause).filter(Boolean);
      (async () => {
        let publicQ = '';
        if (llmAvailable()) { try { publicQ = (await genericizeQuestion(q)).text; } catch (e) { if (e?.code !== 'ANON_BLOCK') console.error('[ask] genericize failed:', e?.message || e); publicQ = ''; } }
        qalog.record({ question: q, publicQ, answer: ans, clauses, tier: 'free' });
      })();
    }
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
// rateLimit + requireGate run BEFORE multer so unauthenticated/abusive requests are rejected
// before up to 6×20MB of upload is buffered into memory (the session token comes via x-session).
app.post('/review', rateLimit, requireGate, uploadReview.fields([{ name: 'eoc', maxCount: 1 }, { name: 'supporting', maxCount: 5 }]), async (req, res) => {
  const t0 = Date.now();
  if (!llmAvailable()) return res.status(503).json({ error: 'Premium review needs the LLM — set ANTHROPIC_API_KEY.' });
  // Paid review: once billing is live, access requires EITHER an active membership (which
  // INCLUDES the full review) OR a one-time review credit. A credit is consumed on SUCCESS
  // (below) only when not covered by membership, so a failed review never burns it. Until
  // billing is connected, use the license-key gate.
  const revEmail = leads.emailForToken(req.sessionToken);
  const billed = billing.billingAvailable();
  let devMode = false, subCovered = false, creditReserved = false;
  // Admin/owner bypass: the admin key may be supplied in the license field; once valid this email
  // is flagged admin (persisted) and runs reviews free.
  const providedAdminKey = billing.adminKeyValid(req.body?.license);
  if (providedAdminKey) billing.grantAdmin(revEmail);
  const verified = leads.isVerified(req.sessionToken); // paid/admin perks require a verified email
  const adminUser = providedAdminKey || (verified && billing.isAdmin(revEmail));
  if (adminUser) {
    subCovered = true; // admin runs reviews free, no credit consumed
  } else if (billed) {
    const ent = billing.entitlements(revEmail);
    // Owns a paid entitlement but hasn't verified this session's email → ask to verify, not pay.
    if (!verified && (ent.subActive || ent.reviews > 0)) return res.status(403).json({ verify: true, error: 'Please verify your email to use your paid review.' });
    subCovered = verified && !!ent.subActive; // membership includes the full EOC review
    if (!subCovered) {
      // Needs a one-time review credit. RESERVE it now (synchronously, before the minutes-long
      // review) so two concurrent requests can't both pass a check-then-consume and get two
      // reviews for one credit. Refunded in the catch if the review fails.
      if (!verified || !billing.useReview(revEmail)) { const pr = billing.pricing(); return res.status(402).json({ pay: 'review', error: `A one-time EOC review (₪${pr.incl.review}) or a monthly membership (₪${pr.incl.subscription}) is required.` }); }
      creditReserved = true;
    }
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
    // credit was already RESERVED before the review (see above) — nothing to consume here.
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
    if (creditReserved) { billing.grant(revEmail, 'review'); creditReserved = false; } // refund the reserved credit — the review didn't complete
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

// Subscription renewal reminders — the ₪115 monthly pass grants 31 days (no auto-charge), so a
// few days before expiry we email the member a one-click renew link. Render Starter is always-on,
// so an in-process daily timer is reliable; the per-cycle flag (renewNotifiedFor) prevents dupes,
// and it re-checks shortly after each boot/deploy.
const RENEW_REMIND_WITHIN_MS = 3 * 24 * 3600 * 1000; // 3 days before expiry
async function runRenewalReminders() {
  try {
    if (!billing.billingAvailable() || !mailAvailable()) return;
    const due = billing.subsNeedingRenewalReminder(RENEW_REMIND_WITHIN_MS);
    for (const s of due) {
      const renewUrl = `${process.env.BASE_URL || ''}/?renew=subscription`;
      const ok = await sendRenewalReminder({ to: s.email, daysLeft: s.daysLeft, renewUrl });
      if (ok) { billing.markRenewalReminded(s.email, s.subUntil); console.log(`[renew] reminder → ${s.email} (${s.daysLeft}d left)`); }
    }
  } catch (e) { console.error('[renew] reminder run failed:', e?.message || e); }
}
setInterval(runRenewalReminders, 12 * 3600 * 1000).unref?.(); // twice daily
setTimeout(runRenewalReminders, 30_000).unref?.();            // once shortly after boot

app.listen(PORT, () => {
  loadKB();
  const std = loadStandard().chunks?.length || 0;
  const llm = llmAvailable() ? `LLM ON (${MODEL})` : 'LLM OFF (set ANTHROPIC_API_KEY) — deterministic cards';
  console.log(`ITL EOC Assistant backend on http://localhost:${PORT}  (${loadKB().items.length} clauses, ${std} SI 6464 passages) · ${llm}`);
});
