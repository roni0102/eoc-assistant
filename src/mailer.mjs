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
