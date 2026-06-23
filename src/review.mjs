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

const SYSTEM = `You are a senior inspector at ITL, an accredited Inspection Body (IB) under Israeli Standard SI 6464 (2017), reviewing a client's filled-in EOC (Evaluation of Conformity) BEFORE they submit it. For each checklist row you are given: the SI 6464 clause, its requirement, and the client's answer. You are also given grounding: the SI 6464 standard text (authoritative for the requirement) and the anonymized history of how this clause was resolved across many past EOCs (the IB comments commonly raised and what closed the item).

Apply ITL's house methodology and judge each row as the IB would:
- PASS — the answer satisfies the requirement; the IB would accept/close it.
- N/A — the requirement genuinely does not apply to this installation.
- AT_RISK — the answer is weak, ambiguous, or incomplete; the IB will probably raise a comment. Predict that comment.
- FAIL — required evidence is missing, wrong, or non-compliant; the item would be held open.

For each row return STRICT JSON (no prose outside the array) with this shape:
{
 "row": <number>,
 "verdict": "PASS" | "N/A" | "AT_RISK" | "FAIL",
 "col_D": "<ITL Results/Remarks per house format>",
 "itl_reply": "<the ITL ping-pong reply per house format>",
 "predicted_ib": "<the IB comment likely to come back, or empty if PASS/N/A>",
 "suggested_fix": "<concrete wording/action that would close the item, or empty if PASS>"
}

House formats (English only, formal inspection language, no first person):
- col_D PASS: "The attached [document] fulfils this item."
- col_D N/A: "Item not applicable — [one-line reason]."
- col_D AT_RISK/FAIL: "[what was submitted]. [what is missing or deficient]."
- itl_reply PASS: "Closed. [document] received and reviewed. PASS."
- itl_reply N/A: "N/A. [one-sentence reason]."
- itl_reply AT_RISK/FAIL: a short formal note stating what is missing; cite the specific SI 6464 clause; end with "Item held open pending submission. FAILED." (cite the clause ONLY for AT_RISK/FAIL, never for PASS/N/A).
Ground predicted_ib and suggested_fix in the corpus history when available ("the IB commonly asks…"). Do not invent requirements. If the client's answer is ambiguous, judge AT_RISK or FAIL and say exactly what clarification is needed. NEVER name or hint at any other client/site/person from the grounding — speak generically.

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

  const items = [], updates = [], score = { PASS: 0, N_A: 0, AT_RISK: 0, FAIL: 0, MISSING: 0, total: 0 };
  for (const r of rows) {
    if (!r.answered) {
      if (r.requirement && r.clause) { score.MISSING++; score.total++;
        items.push({ row: r.row, clause: r.clause, section: r.section, requirement: r.requirement, verdict: 'MISSING', col_D: '', itl_reply: '', predicted_ib: 'Required item not answered — the IB will hold it open.', suggested_fix: 'Provide the required document/evidence for this clause.', client_answer: r.client_answer || '' });
      }
      continue;
    }
    const rev = reviews.get(r.row);
    if (!rev) continue;
    const verdict = String(rev.verdict || '').toUpperCase().replace('N/A', 'N/A');
    score[verdict === 'N/A' ? 'N_A' : (score[verdict] != null ? verdict : 'AT_RISK')]++; score.total++;
    items.push({
      row: r.row, clause: r.clause, section: r.section, requirement: r.requirement,
      client_answer: r.client_answer || '',
      verdict: rev.verdict, col_D: rev.col_D || '', itl_reply: rev.itl_reply || '',
      predicted_ib: rev.predicted_ib || '', suggested_fix: rev.suggested_fix || '',
      observed_in_projects: getClause(r.clause)?.corpus_count || 0,
    });
    updates.push({ row: r.row, col_D: rev.col_D, col_E: (rev.verdict === 'AT_RISK' ? 'FAILED' : rev.verdict), next_itl_col: r.next_itl_col, itl_reply: rev.itl_reply });
  }
  items.sort((a, b) => String(a.clause).localeCompare(String(b.clause), undefined, { numeric: true }));
  return { scoreboard: score, items, updates };
}

export { MODEL };
