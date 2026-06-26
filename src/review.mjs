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

const MODEL = process.env.EOC_MODEL || 'claude-opus-4-8';
let client = null;
const getClient = () => (client ||= new Anthropic());

const SYSTEM = `You are a senior inspector at ITL, an accredited Inspection Body (IB) under Israeli Standard SI 6464 (2017), helping a client PREPARE their EOC (Evaluation of Conformity) before they submit it.

CRITICAL LIMITATION: you can see ONLY the client's typed reply for each line. You CANNOT see the attached documents, drawings, certificates, calculations or test reports themselves. So you must NOT certify that the evidence is compliant. Your job for each row is to tell the client:
(a) WHAT THE IB/ITL WILL EXPECT for this clause — the specific documents, drawings, tests, calculations and certifications an inspector looks for; and
(b) whether their typed reply looks complete and clear, or thin/ambiguous and likely to draw an IB comment.

For each row you get: the SI 6464 clause, its requirement, and the client's typed answer; plus grounding — the SI 6464 standard text (authoritative for the requirement) and the anonymized history of how this clause was resolved across many past EOCs (the IB comments commonly raised and what closed the item).

Judge each row's READINESS (NOT a pass/fail of evidence you cannot see):
- READY — the typed reply is complete and clear and names the right kind of evidence; likely accepted IF the actual evidence matches.
- NEEDS_ATTENTION — the reply is thin, vague, or may not cover what the IB expects; likely to draw a comment.
- N/A — the requirement genuinely does not apply to this installation.
- MISSING — no usable reply, or clearly insufficient.

Return STRICT JSON (no prose outside the array), one object per row, with this shape:
{
 "row": <number>,
 "readiness": "READY" | "NEEDS_ATTENTION" | "N/A" | "MISSING",
 "ib_expectations": "<what the IB/ITL will expect for this clause — the specific documents/drawings/tests/calculations/certifications. ALWAYS fill this; it is the main value of the review.>",
 "reply_assessment": "<short assessment of the client's TYPED reply: is it complete and clear, or what looks thin/ambiguous? Acknowledge you have not seen the attached evidence.>",
 "suggested_fix": "<concrete wording or evidence that would satisfy the IB; empty only if READY.>"
}

Rules (formal inspection English, no first person): ALWAYS populate ib_expectations, even when READY. Cite the SI 6464 clause when you state a requirement. Ground ib_expectations and suggested_fix in the standard + corpus history ("the IB commonly asks for…") — do not invent requirements. NEVER name or hint at any other client/site/person/project from the grounding — speak generically.

Return ONLY a JSON array of one object per input row.`;

// compact grounding for one clause
function groundRow(r) {
  const rec = getClause(r.clause);
  const ib = (rec?.ib_interaction_patterns || []).slice(0, 4)
    .map((p) => `(${p.frequency || 1}×, ${p.resolution}) ${p.ib_comment}`);
  const acc = (rec?.accepted_reply_patterns || []).slice(0, 3)
    .map((p) => `(${p.frequency}${p.is_dominant ? ', most common' : ''}) ${p.pattern}`);
  const std = retrieveStandard(`${r.clause} ${r.requirement || ''}`, 1).map((s) => s.text.slice(0, 500));
  return {
    row: r.row, clause: r.clause, requirement: (r.requirement || '').slice(0, 600),
    client_answer: (r.client_answer || '').slice(0, 800),
    corpus_accepted: acc, corpus_ib_comments: ib, standard: std[0] || '',
    observed_in_projects: rec?.corpus_count || 0,
  };
}

function extractJson(text) {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { return JSON.parse(m[0]); } catch { return []; }
}

async function reviewBatch(type, rows) {
  const payload = rows.map(groundRow);
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: 'user', content: `EOC type: ${type}.\nReview these ${rows.length} rows. Return the JSON array.\n\n${JSON.stringify(payload, null, 1)}` }],
  });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return extractJson(text);
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

/**
 * reviewEOC({ type, rows, limit, onProgress }) -> { scoreboard, items, updates }
 * items: per-row review for display. updates: ready for eoc.writeEOC (annotated xlsx).
 */
export async function reviewEOC({ type, rows, limit, onProgress }) {
  let reviewable = rows.filter((r) => r.reviewable);
  if (limit) reviewable = reviewable.slice(0, limit);
  const byRow = new Map(rows.map((r) => [r.row, r]));
  const reviews = new Map();

  const batches = chunk(reviewable, 6);
  let done = 0;
  // limited concurrency so a large EOC doesn't fire dozens of calls at once
  const CONC = 3;
  for (let i = 0; i < batches.length; i += CONC) {
    const slice = batches.slice(i, i + CONC);
    const settled = await Promise.allSettled(slice.map((b) => reviewBatch(type, b)));
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

  const items = [], updates = [], score = { READY: 0, NEEDS_ATTENTION: 0, N_A: 0, MISSING: 0, total: 0 };
  for (const r of rows) {
    if (!r.answered) {
      if (r.requirement && r.clause) {
        score.MISSING++; score.total++;
        const exp = 'The IB will expect a documented reply with supporting evidence for this clause.';
        items.push({ row: r.row, clause: r.clause, section: r.section, requirement: r.requirement, readiness: 'MISSING', ib_expectations: exp, reply_assessment: 'No reply provided for this line.', suggested_fix: 'Provide the required document/evidence and a written reply for this clause.', client_answer: '', observed_in_projects: getClause(r.clause)?.corpus_count || 0 });
        updates.push({ row: r.row, col_D: `MISSING — ${exp}`, col_E: 'MISSING', next_itl_col: r.next_itl_col, itl_reply: 'Provide the required document/evidence for this clause.' });
      }
      continue;
    }
    const rev = reviews.get(r.row);
    if (!rev) continue;
    const readiness = normReadiness(rev.readiness);
    score[scoreKey[readiness]]++; score.total++;
    const exp = rev.ib_expectations || '';
    const assess = rev.reply_assessment || '';
    const fix = rev.suggested_fix || '';
    items.push({
      row: r.row, clause: r.clause, section: r.section, requirement: r.requirement,
      client_answer: r.client_answer || '',
      readiness, ib_expectations: exp, reply_assessment: assess, suggested_fix: fix,
      observed_in_projects: getClause(r.clause)?.corpus_count || 0,
    });
    // workbook: col D leads with what the IB expects (+ the reply assessment); col E = readiness.
    const colD = `${LABEL[readiness]} — IB will expect: ${exp}${assess ? ` | Reply: ${assess}` : ''}`;
    updates.push({ row: r.row, col_D: colD, col_E: LABEL[readiness], next_itl_col: r.next_itl_col, itl_reply: fix || (readiness === 'READY' ? 'Reply looks complete — ensure the named evidence is attached.' : '') });
  }
  items.sort((a, b) => String(a.clause).localeCompare(String(b.clause), undefined, { numeric: true }));
  return { scoreboard: score, items, updates };
}

export { MODEL };
