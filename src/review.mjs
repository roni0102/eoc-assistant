// review.mjs — PREMIUM full-EOC review engine.
//
// Input: a client's filled EOC (parsed by eoc.mjs). Output: ITL-style review of every
// answered row — verdict, the ITL Results/Remarks (col D), the ITL ping-pong reply, the
// IB comment likely to come back, and a suggested corrected reply — produced by Claude
// running the bundled eoc-fill methodology and grounded in (a) the anonymized corpus of
// how past EOCs resolved the same clause and (b) the SI 6464 standard text.
//
// PRIVACY: the uploaded EOC is the CURRENT client's own data. It is processed in memory,
// never persisted, never added to the public knowledge base. The grounding it's checked
// against is anonymized, so no PAST client is exposed. The report is for this client about
// their own submission, so their own document names legitimately appear (not scrubbed).
import Anthropic from '@anthropic-ai/sdk';
import { getClause, retrieveStandard } from './retrieve.mjs';
import { ruleHint } from './rulesets.mjs';
import { fileBlocks } from './llm.mjs';

const MODEL = process.env.EOC_MODEL || 'claude-opus-4-8';
let client = null;
const getClient = () => (client ||= new Anthropic());

const SYSTEM = `You are a senior inspector at ITL, an accredited Inspection Body (IB) under Israeli Standard SI 6464 (2017), helping a client PREPARE their EOC before submission.

LIMITATION: by default you see ONLY the client's typed reply per line — not their attached documents. EXCEPTION: the client MAY attach supporting files (drawings/documents/photos) for the whole submission — if so, those files are provided to you; when a row's required evidence is clearly visible in an attached file you MAY judge it READY and reference what the file shows. Otherwise do NOT certify evidence you cannot see. For each row tell the client (a) WHAT THE IB/ITL WILL EXPECT (the specific documents, drawings, tests, calculations, certifications) and (b) whether the typed reply (and any attached file) is complete and clear, or thin/vague and likely to draw a comment.

Per row you get: the SI 6464 clause, its requirement, the client's typed answer; grounding (the SI 6464 standard text + the anonymized history of how this clause was resolved); and — when the clause is recognised — a SEVERITY tag and a CANONICAL IB REQUEST.

DECIDE FOR EVERY ROW whether a comment is warranted, from the EVIDENCE in the reply — NOT from whether a stored example exists. A genuine gap with no prior example must still get the correct standard comment. Classify readiness:
- READY — the typed reply is complete and clear and NAMES the specific required evidence (an actual certificate/report/drawing/calculation); likely accepted IF the evidence matches.
- NEEDS_ATTENTION — thin, vague, generic ("see attached", "complies"), or may not cover what the IB expects; will likely draw a comment.
- N/A — genuinely does not apply.
- MISSING — no usable reply, or clearly insufficient.

SAFETY-CRITICAL & STATUTORY ITEMS (severity "safety" or "statutory" — functional safety/SIL, risk assessment, burner/combustion safety, hazardous-area/electrical, pressure-vessel/boiler, electrical-law, fire-service, periodic inspection): these almost ALWAYS carry an IB comment. NEVER mark such an item READY or leave it blank unless the reply explicitly names the specific required evidence. When in doubt → NEEDS_ATTENTION. For these items produce the COMPLETE structured IB request (what to provide AND what to prove), using the CANONICAL IB REQUEST as the basis — never a single status word, never blank.

LANGUAGE (bilingual, equal weight): write ib_expectations, reply_assessment and suggested_fix in the SAME LANGUAGE as the requirement — Hebrew requirement → Hebrew; English → English. Hebrew items are first-class; never skip a Hebrew item.

SECTION CONSISTENCY: rows carry a "section". When a requirement is cross-cutting (a shared status or shared demand applies to a block of rows in the same section), apply the comment CONSISTENTLY to every affected row — do not catch some and drop the rest.

Return STRICT JSON (no prose outside the array), one object per row:
{ "row": <number>, "readiness": "READY"|"NEEDS_ATTENTION"|"N/A"|"MISSING", "ib_expectations": "<always filled; the specific evidence the IB expects>", "reply_assessment": "<short read of the typed reply; acknowledge you haven't seen the attached evidence>", "suggested_fix": "<concrete wording/evidence that would satisfy the IB; empty only if READY>" }

ALWAYS populate ib_expectations (even when READY). Cite the SI 6464 clause when stating a requirement. Ground in the standard + corpus + canonical request — do not invent requirements. NEVER name or hint at any other client/site/person/project — speak generically. NEVER cite the number of past EOCs/projects/records behind a point; if you mention how common something is, use only an approximate percentage (e.g. "~65%").

Return ONLY a JSON array, one object per input row.`;

// compact grounding for one clause. Prevalence is given to the model as an approximate percentage
// (never raw project/EOC counts), matching the no-count rule in SYSTEM.
function groundRow(r) {
  const rec = getClause(r.clause);
  const total = rec?.corpus_count || 0;
  const pct = (n) => (total ? `~${Math.max(1, Math.min(100, Math.round((Number(n) || 0) / total * 100)))}%` : 'common');
  const ib = (rec?.ib_interaction_patterns || []).slice(0, 4)
    .map((p) => `(${pct(p.frequency || 1)}, ${p.resolution}) ${p.ib_comment}`);
  const acc = (rec?.accepted_reply_patterns || []).slice(0, 3)
    .map((p) => `(${pct(p.frequency || 1)}${p.is_dominant ? ', most common' : ''}) ${p.pattern}`);
  const std = retrieveStandard(`${r.clause} ${r.requirement || ''}`, 1).map((s) => s.text.slice(0, 500));
  const rule = ruleHint(r.clause, r.requirement); // severity + canonical IB request (bilingual)
  return {
    row: r.row, clause: r.clause, section: r.section || '', requirement: (r.requirement || '').slice(0, 600),
    client_answer: (r.client_answer || '').slice(0, 800),
    severity: rule?.severity || 'standard',
    canonical_ib_request: rule?.canonical_ib_request || '',
    corpus_accepted: acc, corpus_ib_comments: ib, standard: std[0] || '',
  };
}

function extractJson(text) {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { return JSON.parse(m[0]); } catch { return []; }
}

async function reviewBatch(type, rows, attachments) {
  const payload = rows.map(groundRow);
  const text = `EOC type: ${type}.${attachments?.length ? ` ${attachments.length} SUPPORTING file(s) (drawings/documents) are attached below — when a row's required evidence is clearly visible in them, you MAY judge it READY and reference what the file shows; otherwise assess from the typed reply as usual.` : ''}\nReview these ${rows.length} rows. Return the JSON array.\n\n${JSON.stringify(payload, null, 1)}`;
  const content = [...fileBlocks(attachments), { type: 'text', text }];
  const res = await getClient().messages.create({ model: MODEL, max_tokens: 4000, system: SYSTEM, messages: [{ role: 'user', content }] });
  const out = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return extractJson(out);
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

/**
 * reviewEOC({ type, rows, limit, onProgress }) -> { scoreboard, items, updates }
 * items: per-row review for display. updates: ready for eoc.writeEOC (annotated xlsx).
 */
// non-requirement rows that must NOT be counted as Missing (notes, list/section intros).
const isStructural = (req, clause) => {
  const s = String(req || '').trim();
  if (!s) return true;
  if (/^(note|notes|nb|הערה|הערות)\b/i.test(s)) return true;
  if (/\.0$/.test(String(clause || '')) && /(minimum requirements|file review|list of|the following|תוכן|רשימת)\b/i.test(s)) return true;
  return false;
};
const naVerdict = (r) => /^n\/?a$/i.test(String(r.verdict || '').trim());
// already satisfied: an explicit pass verdict, or the IB's last ping-pong entry closed/accepted it.
const ibClosed = (r) => {
  if (/^(pass|accept|closed|אושר|סגור|תקין)/i.test(String(r.verdict || '').trim())) return true;
  const itl = (r.pingpong || []).filter((p) => p.party === 'ITL');
  const last = itl[itl.length - 1];
  return !!(last && /^(closed|accepted|pass|item closed|אושר|סגור|תקין)/i.test(String(last.content || '').trim()));
};
const isOpen = (r) => !naVerdict(r) && !ibClosed(r);

export async function reviewEOC({ type, rows, limit, attachments, onProgress }) {
  // LLM-review only OPEN, answered, non-structural requirement rows (saves tokens + correctness).
  let reviewable = rows.filter((r) => r.reviewable && r.requirement && r.clause && !isStructural(r.requirement, r.clause) && isOpen(r));
  if (limit) reviewable = reviewable.slice(0, limit);
  const reviews = new Map();

  const batches = chunk(reviewable, 6);
  let done = 0;
  // limited concurrency so a large EOC doesn't fire dozens of calls at once
  const CONC = 3;
  for (let i = 0; i < batches.length; i += CONC) {
    const slice = batches.slice(i, i + CONC);
    const settled = await Promise.allSettled(slice.map((b) => reviewBatch(type, b, attachments)));
    settled.forEach((s) => { if (s.status === 'fulfilled') for (const it of s.value) if (it && it.row != null) reviews.set(it.row, it); });
    done += slice.reduce((n, b) => n + b.length, 0);
    onProgress?.(Math.min(done, reviewable.length), reviewable.length);
  }

  // readiness → workbook column-E label
  const LABEL = { READY: 'READY', NEEDS_ATTENTION: 'NEEDS ATTENTION', 'N/A': 'N/A', MISSING: 'MISSING' };
  const normReadiness = (v) => {
    const s = String(v || '').toUpperCase().replace(/\s+/g, '_');
    if (s === 'READY') return 'READY';
    if (s === 'N/A' || s === 'NA' || s === 'N_A') return 'N/A';
    if (s === 'MISSING') return 'MISSING';
    return 'NEEDS_ATTENTION';
  };
  const scoreKey = { READY: 'READY', NEEDS_ATTENTION: 'NEEDS_ATTENTION', 'N/A': 'N_A', MISSING: 'MISSING' };

  const he = (s) => /[֐-׿]/.test(String(s || ''));
  const looksSpecific = (a) => { const s = String(a || ''); return s.length >= 12 && (/\d/.test(s) || /(cert|certificate|report|drawing|datasheet|p&id|appendix|\brev\b|תעודה|דו"?ח|תרשים|מסמך|נספח|אישור)/i.test(s)); };

  // per-row bucketing (Fix 2): respect the EOC's own N/A and IB-closure; exclude structural rows
  // from Missing; only genuinely-required open/unanswered items become Missing / Needs-attention.
  const items = [];
  let structural = 0, notReviewed = 0;
  for (const r of rows) {
    if (!r.requirement || !r.clause) continue; // not an item row
    const rule = ruleHint(r.clause, r.requirement);
    const critical = !!rule && (rule.severity === 'safety' || rule.severity === 'statutory');
    const inHe = he(r.requirement);
    const base = { row: r.row, clause: r.clause, section: r.section, requirement: r.requirement, next_itl_col: r.next_itl_col, severity: rule?.severity || 'standard' };

    if (isStructural(r.requirement, r.clause)) { structural++; continue; }                 // note / header / intro
    if (naVerdict(r)) { items.push({ ...base, readiness: 'N/A', ib_expectations: inHe ? 'הסעיף סומן כלא רלוונטי.' : 'Marked not applicable.', reply_assessment: '', suggested_fix: '', client_answer: r.client_answer || '' }); continue; }
    if (ibClosed(r)) { items.push({ ...base, readiness: 'READY', ib_expectations: inHe ? 'הסעיף כבר התקבל / נסגר בטופס.' : 'Already accepted / closed in the EOC.', reply_assessment: '', suggested_fix: '', client_answer: r.client_answer || '' }); continue; }

    if (!r.answered) { // required item with no acceptable answer → MISSING (canonical bilingual request)
      const exp = (rule && rule.canonical_ib_request) || (inHe ? 'הגוף הבודק יצפה לתשובה מתועדת עם ראיות תומכות לסעיף זה.' : 'The IB will expect a documented reply with supporting evidence for this clause.');
      items.push({ ...base, readiness: 'MISSING', ib_expectations: exp, reply_assessment: inHe ? 'לא ניתנה תשובה לשורה זו.' : 'No reply provided for this line.', suggested_fix: inHe ? 'יש להגיש את המסמך/הראיה הנדרשים ותשובה כתובה לסעיף זה.' : 'Provide the required document/evidence and a written reply for this clause.', client_answer: '' });
      continue;
    }
    const rev = reviews.get(r.row);
    if (!rev) { notReviewed++; continue; } // answered but beyond the cap / LLM failed
    let readiness = normReadiness(rev.readiness);
    let exp = rev.ib_expectations || '';
    let fix = rev.suggested_fix || '';
    if (critical) {
      if (!exp) exp = rule.canonical_ib_request;
      if (readiness === 'READY' && !looksSpecific(r.client_answer)) { readiness = 'NEEDS_ATTENTION'; if (!fix) fix = rule.canonical_ib_request; }
    }
    items.push({ ...base, readiness, ib_expectations: exp, reply_assessment: rev.reply_assessment || '', suggested_fix: fix, client_answer: r.client_answer || '' });
  }

  propagateSection(items); // cross-cutting status propagation across a block

  const score = { READY: 0, NEEDS_ATTENTION: 0, N_A: 0, MISSING: 0 };
  const updates = [];
  for (const it of items) {
    score[scoreKey[it.readiness]]++;
    const colD = `${LABEL[it.readiness]} — IB will expect: ${it.ib_expectations}${it.reply_assessment ? ` | Reply: ${it.reply_assessment}` : ''}`;
    updates.push({ row: it.row, col_D: colD, col_E: LABEL[it.readiness], next_itl_col: it.next_itl_col, itl_reply: it.suggested_fix || (it.readiness === 'READY' ? 'Reply looks complete — ensure the named evidence is attached.' : '') });
  }
  // reconciliation: assessed + not_reviewed (+ structural) accounts for every clause row in scope.
  score.not_reviewed = notReviewed;
  score.structural = structural;
  score.assessed = items.length;                          // rows that got a bucket
  score.requirements = items.length + notReviewed;        // real requirement rows in scope (excl. structural)
  score.total = items.length + notReviewed + structural;  // every clause+requirement row seen
  items.sort((a, b) => String(a.clause).localeCompare(String(b.clause), undefined, { numeric: true }));
  return { scoreboard: score, items, updates };
}

// When a block of rows in the SAME section shares the SAME non-empty typed reply (a cross-cutting
// status/demand), give them ONE consistent assessment — the most severe readiness in the group plus
// its fullest expectation/fix — so a shared status isn't caught on some rows and dropped on others.
function propagateSection(items) {
  const SEV = { MISSING: 3, NEEDS_ATTENTION: 2, READY: 1, 'N/A': 0 };
  const groups = new Map();
  for (const it of items) {
    const ans = String(it.client_answer || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (ans.length < 4) continue; // shared real replies only — never propagate over blanks
    const key = (it.section || '') + '||' + ans;
    let arr = groups.get(key); if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(it);
  }
  for (const g of groups.values()) {
    // Only propagate among rows the reviewer actually flagged — never drag an explicit N/A (the
    // client marked it not-applicable) up to the group's worst readiness.
    const flagged = g.filter((it) => it.readiness !== 'N/A');
    if (flagged.length < 2) continue;
    const rep = flagged.slice().sort((a, b) => (SEV[b.readiness] - SEV[a.readiness]) || ((b.ib_expectations || '').length - (a.ib_expectations || '').length))[0];
    for (const it of flagged) { it.readiness = rep.readiness; it.ib_expectations = rep.ib_expectations; it.suggested_fix = rep.suggested_fix; }
  }
}

export { MODEL };
