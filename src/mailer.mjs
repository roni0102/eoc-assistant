// mailer.mjs — outbound email.
//
// Delivery prefers the Resend HTTP API (RESEND_API_KEY) because it works over HTTPS:443 —
// many hosts (Render's free tier included) BLOCK outbound SMTP, so nodemailer/Gmail hangs.
// Falls back to SMTP/nodemailer (SMTP_HOST/SMTP_USER) if no Resend key. GRACEFUL: if neither
// is configured, mailAvailable() is false and every send is silently skipped.
import nodemailer from 'nodemailer';

// --- Resend (preferred) ---
const RESEND_KEY = process.env.RESEND_API_KEY || '';
// On Resend's free tier 'onboarding@resend.dev' works with no domain setup (to your own address).
const RESEND_FROM = process.env.RESEND_FROM || 'EOC Assistant <onboarding@resend.dev>';

// --- SMTP (fallback) ---
const HOST = process.env.SMTP_HOST || '';
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const PORT = Number(process.env.SMTP_PORT || 587);
const FROM = process.env.EMAIL_FROM || USER;

// Internal addresses that receive notifications.
const EXPERT_NOTIFY = process.env.EXPERT_NOTIFY_EMAIL || 'roni0102@gmail.com';
const BUG_NOTIFY = process.env.BUG_NOTIFY_EMAIL || EXPERT_NOTIFY;

const usingResend = () => !!RESEND_KEY;
export const mailAvailable = () => !!(RESEND_KEY || (HOST && USER));

let transport = null;
const getTransport = () => (transport ||= nodemailer.createTransport({
  host: HOST, port: PORT, secure: PORT === 465, auth: USER ? { user: USER, pass: PASS } : undefined,
}));

/**
 * deliver({ to, subject, text, replyTo, attachments }) — unified send.
 * attachments: [{ filename, content: Buffer, contentType }]. Throws on failure.
 */
async function deliver({ to, subject, text, replyTo, attachments }) {
  if (usingResend()) {
    const body = {
      from: RESEND_FROM, to: Array.isArray(to) ? to : [to], subject, text,
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(attachments && attachments.length
        ? { attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })) }
        : {}),
    };
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return true;
  }
  await getTransport().sendMail({
    from: FROM, to, subject, text, replyTo,
    attachments: (attachments || []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  });
  return true;
}

/** mailDiag(): confirm email actually works. For Resend it sends a tiny test to the notify
 *  address (Resend has no connection-verify); for SMTP it verifies the login (no send). */
export async function mailDiag() {
  const mode = usingResend() ? 'resend' : ((HOST && USER) ? 'smtp' : 'none');
  const cfg = { available: mailAvailable(), mode, from: usingResend() ? RESEND_FROM : (FROM || '(unset)'), notify: BUG_NOTIFY };
  if (!mailAvailable()) return { ...cfg, ok: false, error: 'No email configured — set RESEND_API_KEY (recommended) or SMTP_HOST/SMTP_USER.' };
  try {
    if (usingResend()) { await deliver({ to: BUG_NOTIFY, subject: 'EOC Assistant — mail test ✅', text: 'If you can read this, email delivery is working.' }); return { ...cfg, ok: true, error: null, note: `test email sent to ${BUG_NOTIFY}` }; }
    await getTransport().verify();
    return { ...cfg, ok: true, error: null };
  } catch (e) { return { ...cfg, ok: false, error: String(e?.message || e).slice(0, 400) }; }
}

/**
 * sendReviewEmail({ to, type, scoreboard, attachment, filename }) -> boolean
 * Emails the client their review summary + the annotated workbook. Never throws.
 */
export async function sendReviewEmail({ to, type, scoreboard, attachment, filename }) {
  if (!mailAvailable() || !to) return false;
  const s = scoreboard || {};
  const summary = [`Ready: ${s.READY || 0}`, `Needs attention: ${s.NEEDS_ATTENTION || 0}`, `N/A: ${s.N_A || 0}`, `Missing: ${s.MISSING || 0}`].join(' · ');
  const text =
    `Attached is your pre-submission review of your ${type} EOC.\n\n` +
    `Summary — ${summary}.\n\n` +
    `For each line the review shows what the Inspection Body (IB/ITL) will expect and how ` +
    `your written reply looks. Note: this is reference guidance only — it does not see your ` +
    `actual attached documents/drawings and is not a formal ITL determination.\n\n— EOC Assistant`;
  try {
    await deliver({ to, subject: `Your ${type} EOC pre-submission review`, text,
      attachments: attachment ? [{ filename: filename || 'EOC-review.xlsx', content: attachment }] : [] });
    return true;
  } catch (e) { try { console.error('[mail] review send failed:', e?.message || e); } catch {} return false; }
}

/**
 * sendExpertEmail({ booking }) -> boolean. Internal summary of a consultation booking.
 */
export async function sendExpertEmail({ booking }) {
  if (!mailAvailable() || !booking) return false;
  const c = booking.consult || {};
  const slots = (c.slots || []).map((slot) => `  • ${String(slot).replace('T', ' ')}`).join('\n');
  const text =
    `New 30-minute expert consultation request from the EOC Assistant.\n\n` +
    `Client\n  Company: ${booking.company || '—'}\n  Email:   ${booking.email || '—'}\n  Phone:   ${booking.phone || '—'}\n\n` +
    `Topic\n  ${c.topic || '—'}\n\n` +
    `What they need\n  ${(c.description || '—').replace(/\n/g, '\n  ')}\n\n` +
    `Proposed times\n${slots || '  • —'}\n\n` +
    `Submitted: ${booking.ts}\n\n— EOC Assistant`;
  try {
    await deliver({ to: EXPERT_NOTIFY, replyTo: booking.email || undefined,
      subject: `Expert consult request — ${booking.company || booking.email || 'client'} · ${c.topic || 'no topic'}`, text });
    return true;
  } catch (e) { try { console.error('[mail] expert notify failed:', e?.message || e); } catch {} return false; }
}

/**
 * sendBugEmail({ bug, file }) -> boolean. Internal bug report with optional screenshot/file.
 */
export async function sendBugEmail({ bug, file }) {
  if (!mailAvailable() || !bug) return false;
  const b = bug.bug || {};
  const text =
    `New bug report from the EOC Assistant.\n\n${b.message || '—'}\n\n` +
    `— Reporter: ${bug.email || '—'}${bug.company ? ' (' + bug.company + ')' : ''}\n` +
    `— Where: ${b.context || '—'}\n— Browser: ${b.ua || '—'}\n` +
    `— Attachment: ${file?.name || b.attachment || 'none'}\n— Time: ${bug.ts}`;
  try {
    await deliver({ to: BUG_NOTIFY, replyTo: bug.email || undefined,
      subject: `Bug report — EOC Assistant${bug.company ? ' · ' + bug.company : ''}`, text,
      attachments: (file && file.buffer) ? [{ filename: file.name || 'screenshot', content: file.buffer, contentType: file.mimetype }] : [] });
    return true;
  } catch (e) { try { console.error('[mail] bug notify failed:', e?.message || e); } catch {} return false; }
}

/**
 * sendVerificationCode({ to, code }) -> boolean. Emails a 6-digit code to confirm the address
 * before paid access. Bilingual. Never throws.
 */
export async function sendVerificationCode({ to, code }) {
  if (!mailAvailable() || !to) return false;
  const text =
    `קוד האימות שלך ל-EOC Assistant הוא: ${code}\n` +
    `הקוד תקף ל-10 דקות. אם לא ביקשת אותו, אפשר להתעלם מהודעה זו.\n\n` +
    `— — —\n\n` +
    `Your EOC Assistant verification code is: ${code}\n` +
    `It is valid for 10 minutes. If you didn't request it, you can ignore this email.\n\n— EOC Assistant`;
  try { await deliver({ to, subject: `EOC Assistant — קוד אימות / verification code: ${code}`, text }); return true; }
  catch (e) { try { console.error('[mail] verification code failed:', e?.message || e); } catch {} return false; }
}

/**
 * sendRenewalReminder({ to, daysLeft, renewUrl }) -> boolean. Reminds a member their monthly
 * pass is about to expire, with a one-click renew link. Bilingual (HE primary). Never throws.
 */
export async function sendRenewalReminder({ to, daysLeft, renewUrl }) {
  if (!mailAvailable() || !to) return false;
  const heWhen = daysLeft <= 1 ? 'מחר' : `בעוד ${daysLeft} ימים`;
  const enWhen = daysLeft <= 1 ? 'tomorrow' : `in ${daysLeft} days`;
  const text =
    `המנוי החודשי שלך ל-EOC Assistant יפוג ${heWhen}.\n` +
    `כדי להמשיך עם שאלות ללא הגבלה + בדיקת EOC מלאה, אפשר לחדש כאן:\n${renewUrl}\n\n` +
    `אם אינך מעוניין/ת לחדש — אין צורך לעשות דבר; הגישה פשוט תסתיים בתום התקופה.\n\n` +
    `— — —\n\n` +
    `Your EOC Assistant monthly membership expires ${enWhen}.\n` +
    `To keep unlimited questions + your full EOC review, renew here:\n${renewUrl}\n\n` +
    `If you'd rather not renew, no action is needed — access simply ends at the end of the period.\n\n— EOC Assistant`;
  try {
    await deliver({ to, subject: `EOC Assistant — המנוי שלך יפוג ${heWhen} · membership expires ${enWhen}`, text });
    return true;
  } catch (e) { try { console.error('[mail] renewal reminder failed:', e?.message || e); } catch {} return false; }
}
