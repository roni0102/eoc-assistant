// answer.mjs — compose a grounded, anonymous answer from retrieved KB records.
//
// The LLM is abstracted behind composeAnswer(): today it builds a deterministic,
// fully-grounded answer card from the retrieved record (runs with NO API key).
// When ANTHROPIC_API_KEY is set, callLLM() can be filled in to phrase the same
// grounded facts more naturally — but it must stay grounded in `retrieved` only
// and pass the anonymity guard below. The structured fields never change.
import { scan } from './anonymize.mjs';

const DISCLAIMER =
  'Reference guidance only — not a formal ITL determination. Final approval is subject to ITL review of the actual submission.';

const RESOLUTION_LABEL = {
  accepted: 'typically accepted',
  'accepted-with-condition': 'accepted as a condition in the approval',
  'comment-raised': 'commonly draws this IB comment',
  'at-risk': 'likely to draw an IB comment',
  'n/a': 'accepted as not applicable',
  open: 'left open pending further input',
};

// Build the "how the IB typically responds" summaries from anonymized patterns.
function ibResponses(item) {
  return (item.ib_interaction_patterns || []).map((p) => ({
    outcome: RESOLUTION_LABEL[p.resolution] || p.resolution,
    ib_comment: p.ib_comment,
    frequency: p.frequency || 1,
    closing_note: p.closing_note || null,
  }));
}

// The product: how this item was actually answered across the corpus.
function acceptedPatterns(item) {
  return (item.accepted_reply_patterns || []).map((p) => ({
    pattern: p.pattern,
    frequency: p.frequency || 1,
    is_dominant: !!p.is_dominant,
  }));
}

/**
 * composeAnswer({ query, retrieved }): returns an answer object, or a
 * not-covered answer. Always runs the anonymity guard before returning;
 * fails closed (throws) if any identifier is present.
 */
export function composeAnswer({ query, retrieved }) {
  if (retrieved.mode === 'none' || !retrieved.items.length) {
    return guard({
      covered: false,
      query,
      message:
        'This question is not covered by the current knowledge base. ' +
        'Please consult the relevant section of SI 6464 (2017), or rephrase using an SI 6464 clause number (e.g. "7.2.1.5") or keywords.',
      disclaimer: DISCLAIMER,
    });
  }

  const primary = retrieved.items[0];
  const cards = retrieved.items.map((it) => ({
    clause: it.clause || it.line,
    section: it.section || it.form || null,
    form: it.form || null,
    document: it.document || null,
    requirement: it.requirement_en || it.requirement_he || null,
    standard_reply: it.standard_reply || null,        // scaffold / context only
    // ===== the product: learned from the corpus of past filled EOCs =====
    corpus_count: it.corpus_count || 0,
    accepted_reply_patterns: acceptedPatterns(it),
    ib_responses: ibResponses(it),
    common_pitfalls: it.common_pitfalls || [],
    source_refs: it.source_refs || [],
  }));

  return guard({
    covered: true,
    mode: retrieved.mode, // 'clause' | 'search'
    query,
    primary_clause: primary.clause || primary.line,
    cards,
    disclaimer: DISCLAIMER,
  });
}

// Anonymity guard: scan every string in the outgoing answer. Fail closed.
// Skip code-generated structural fields whose KEY contains "clause" (clause,
// primary_clause) or "source_refs" — SI 6464 clause numbers like "7.2.1.5" look
// like dates but carry no client info. No corpus-text field name contains these.
// (also skip `query` — the echoed CURRENT-user input; it is not past-client corpus
// data, so a clause-number query like "7.2.1.10" must not trip the date detector.)
const GUARD_SKIP = /clause|source_refs|query/;
function guard(answer) {
  const hits = [];
  (function walk(v, path) {
    if (GUARD_SKIP.test(path)) return;
    if (typeof v === 'string') hits.push(...scan(v));
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  })(answer, '$');
  if (hits.length) {
    const e = new Error(`anonymity guard blocked answer: ${hits.map((h) => h.match).join(', ')}`);
    e.code = 'ANON_BLOCK';
    throw e;
  }
  return answer;
}

// Placeholder for the optional LLM phrasing pass (Claude). Intentionally unused
// until a key is wired; kept here so the integration point is explicit.
// eslint-disable-next-line no-unused-vars
export async function callLLM(_groundedAnswer) {
  throw new Error('LLM phrasing not wired yet — set ANTHROPIC_API_KEY and implement.');
}

export { DISCLAIMER };
