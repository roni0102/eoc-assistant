// mailer.mjs — optional outbound email (SMTP via nodemailer).
//
// Used to email the client a copy of their EOC review (annotated workbook attached).
// GRACEFUL: if SMTP_HOST/SMTP_USER are unset, mailAvailable() is false and the server
// simply skips email (the on-page download still works). Works with any SMTP provider —
// Google Workspace, SendGrid, Mailgun, Resend, etc. (see .env.example).
import nodemailer from 'nodemailer';

const HOST = process.env.SMTP_HOST || '';
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const PORT = Number(process.env.SMTP_PORT || 587);
const FROM = process.env.EMAIL_FROM || USER;
// Internal address that gets a summary whenever a client books an expert consultation.
const EXPERT_NOTIFY = process.env.EXPERT_NOTIFY_EMAIL || 'roni@rkbf.pro';
// Internal address that gets a copy of every user-submitted bug report.
const BUG_NOTIFY = process.env.BUG_NOTIFY_EMAIL || EXPERT_NOTIFY;

export const mailAvailable = () => !!(HOST && USER);

let transport = null;
const getTransport = () => (transport ||= nodemailer.createTransport({
  host: HOST, port: PORT, secure: PORT === 465, auth: USER ? { user: USER, pass: PASS } : undefined,
}));

/**
 * sendReviewEmail({ to, type, scoreboard, attachment, filename }) -> boolean
 * Emails the client their review summary + the annotated workbook. Never throws into the
 * request path (returns false on failure / when not configured).
 */
export async function sendReviewEmail({ to, type, scoreboard, attachment, filename }) {
  if (!mailAvailable() || !to) return false;
  const s = scoreboard || {};
  const summary = [
    `Ready: ${s.READY || 0}`,
    `Needs attention: ${s.NEEDS_ATTENTION || 0}`,
    `N/A: ${s.N_A || 0}`,
    `Missing: ${s.MISSING || 0}`,
  ].join(' · ');
  const text =
    `Attached is your pre-submission review of your ${type} EOC.\n\n` +
    `Summary — ${summary}.\n\n` +
    `For each line the review shows what the Inspection Body (IB/ITL) will expect and how ` +
    `your written reply looks. Note: this is reference guidance only — it does not see your ` +
    `actual attached documents/drawings and is not a formal ITL determination.\n\n— EOC Assistant`;
  try {
    await getTransport().sendMail({
      from: FROM, to,
      subject: `Your ${type} EOC pre-submission review`,
      text,
      attachments: attachment ? [{ filename: filename || 'EOC-review.xlsx', content: attachment }] : [],
    });
    return true;
  } catch (e) {
    try { console.error('[mail] send failed:', e?.message || e); } catch {}
    return false;
  }
}

/**
 * sendExpertEmail({ booking }) -> boolean
 * Emails an internal summary of a new expert-consultation booking to EXPERT_NOTIFY
 * (default roni@rkbf.pro). Reply-To is set to the client so the team can answer directly.
 * Never throws into the request path (returns false on failure / when SMTP isn't configured).
 */
export async function sendExpertEmail({ booking }) {
  if (!mailAvailable() || !booking) return false;
  const c = booking.consult || {};
  const slots = (c.slots || []).map((s) => `  • ${String(s).replace('T', ' ')}`).join('\n');
  const text =
    `New 30-minute expert consultation request from the EOC Assistant.\n\n` +
    `Client\n` +
    `  Company: ${booking.company || '—'}\n` +
    `  Email:   ${booking.email || '—'}\n` +
    `  Phone:   ${booking.phone || '—'}\n\n` +
    `Topic\n  ${c.topic || '—'}\n\n` +
    `What they need\n  ${(c.description || '—').replace(/\n/g, '\n  ')}\n\n` +
    `Proposed times\n${slots || '  • —'}\n\n` +
    `Submitted: ${booking.ts}\n\n— EOC Assistant`;
  try {
    await getTransport().sendMail({
      from: FROM,
      to: EXPERT_NOTIFY,
      replyTo: booking.email || undefined,
      subject: `Expert consult request — ${booking.company || booking.email || 'client'} · ${c.topic || 'no topic'}`,
      text,
    });
    return true;
  } catch (e) {
    try { console.error('[mail] expert notify failed:', e?.message || e); } catch {}
    return false;
  }
}

/**
 * sendBugEmail({ bug }) -> boolean. Emails a user-submitted bug report to BUG_NOTIFY
 * (default roni@rkbf.pro). Graceful no-op when SMTP isn't configured.
 */
export async function sendBugEmail({ bug }) {
  if (!mailAvailable() || !bug) return false;
  const b = bug.bug || {};
  const text =
    `New bug report from the EOC Assistant.\n\n` +
    `${b.message || '—'}\n\n` +
    `— Reporter: ${bug.email || '—'}${bug.company ? ' (' + bug.company + ')' : ''}\n` +
    `— Where: ${b.context || '—'}\n` +
    `— Browser: ${b.ua || '—'}\n` +
    `— Time: ${bug.ts}`;
  try {
    await getTransport().sendMail({
      from: FROM, to: BUG_NOTIFY, replyTo: bug.email || undefined,
      subject: `Bug report — EOC Assistant${bug.company ? ' · ' + bug.company : ''}`,
      text,
    });
    return true;
  } catch (e) {
    try { console.error('[mail] bug notify failed:', e?.message || e); } catch {}
    return false;
  }
}
