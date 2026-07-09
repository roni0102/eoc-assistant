// llm.mjs — the "LLM connected to the database" layer.
//
// Claude answers the client's question grounded STRICTLY in the retrieved,
// already-anonymized corpus records (kb.json). The LLM never sees raw client
// files — only the scrubbed accepted-reply / IB-comment patterns — so it cannot
// echo a past client's identity. Its output is still run through the anonymity
// guard (fail-closed) before it reaches the user.
//
// Set ANTHROPIC_API_KEY (env var or .env) to enable. Without it, /ask falls back
// to the deterministic card. Model is configurable via EOC_MODEL.
import Anthropic from '@anthropic-ai/sdk';
import { scanAnswer } from './anonymize.mjs';

const MODEL = process.env.EOC_MODEL || 'claude-opus-4-8';
// Translation is a simple, high-volume-friendly task → default to fast/cheap Haiku.
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'claude-haiku-4-5-20251001';

let client = null;
const getClient = () => (client ||= new Anthropic()); // reads ANTHROPIC_API_KEY
export const llmAvailable = () => !!process.env.ANTHROPIC_API_KEY;

const SYSTEM = `You are the ITL EOC Assistant — a public assistant that helps clients fill out their Evaluation of Conformity (EOC) under Israeli Standard SI 6464 (2017), for natural-gas piping (Chapter 7) and industrial appliances / IAA (Chapters 4–6).

You are given TWO grounding sources below:
A) STANDARD — verbatim passages from SI 6464 (2017) and its amendments, plus ITL clarification memos. This is the AUTHORITATIVE source for what the standard actually requires. (Note: Hebrew passages were extracted from PDF and may have reversed word order — read them for meaning.)
B) CORPUS — ITL's anonymized resolved inspection history. Each record is one clause with: the real accepted reply patterns clients used (and how common each is, given as an approximate percentage), the IB (Inspection Body) comments commonly raised and how items were closed, and common pitfalls.

Use the STANDARD to state what is required and to cite the clause; use the CORPUS to explain how it is actually answered and what the IB does. Prefer the STANDARD when the two conflict on a requirement.

ABSOLUTE RULES:
1. ANONYMITY — never name, hint at, or imply any specific client, site, company, plant, person, project, document ID, or date tied to a project. The corpus is already anonymized; keep it that way. Speak only generically: "SI 6464 requires…", "An acceptable reply states…", "The IB typically responds…", "The common approach is…". NEVER cite the number of past EOCs, projects, records, or cases behind an answer (do not write "used in 28 of 43 EOCs", "seen in N projects", etc.) — express how common something is ONLY as an approximate percentage (e.g. "~65% alignment", "used in roughly two-thirds of cases").
2. GROUNDING — answer ONLY from the STANDARD and CORPUS provided. Do not invent requirements or replies. If neither source covers the question, say so plainly and point to the relevant SI 6464 chapter/clause; do not guess.
3. Cite the SI 6464 clause number when you state a requirement (e.g. "SI 6464 §7.2.1.5 requires…").
4. Be practical and concise. Lead with the answer. When useful, give: what the clause requires (from the standard), the most common accepted reply approach (state how widely it's used as an approximate percentage, e.g. "the most common accepted reply, ~65% alignment"), the IB comment to expect, and the wording that typically closes the item.
5. APPLIANCE AWARENESS — IAA (Ch.4–6) covers several gas appliances: steam boilers, boilers, furnaces, water heaters, dryers, gas turbines, engines, thermal oil heaters, thermal oxidizers (RTO), etc. Each corpus record lists which appliance types it was observed for. If the client names an appliance, tailor the answer to that appliance and say how common the clause/answer is for it; if the appliance isn't represented in the corpus for that clause, say the requirement still applies but no appliance-specific history is available.
6. CONVERSATION — this is an ongoing chat. Use the earlier turns to understand follow-up questions (e.g. "what about for a furnace?", "is that enough to close it?", "and the next item?"). Carry over the clause/appliance/topic from earlier unless the client changes it. Be concise on follow-ups; don't repeat what you already said — build on it. The CORPUS/STANDARD extracts attached to the latest turn are the grounding for the current question; earlier turns are for continuity.
7. Handle Hebrew and English. If the client writes in Hebrew, answer in Hebrew.
7. End every answer with this exact line on its own:
"Reference guidance only — not a formal ITL determination. Final approval is subject to ITL review of the actual submission."`;

function renderContext(cards) {
  // Prevalence is expressed to the model ONLY as an approximate percentage (precomputed in
  // answer.mjs) — never raw project/EOC counts — so its prose can't reveal the underlying record set.
  const pctStr = (p) => (p.pct != null ? `~${p.pct}%` : 'common');
  return cards.map((c) => {
    const acc = (c.accepted_reply_patterns || []).slice(0, 5)
      .map((p) => `   - (${pctStr(p)} alignment${p.is_dominant ? ', most common' : ''}) ${p.pattern}`).join('\n');
    const ib = (c.ib_responses || c.ib_interaction_patterns || []).slice(0, 6)
      .map((p) => `   - (${pctStr(p)}, ${p.resolution || p.outcome || ''}) ${p.ib_comment}`).join('\n');
    const pit = (c.common_pitfalls || []).slice(0, 4).map((p) => `   - ${p}`).join('\n');
    const appl = (c.appliance_breakdown || []).slice(0, 6)
      .map((a) => a.appliance).join(', ');
    return [
      `CLAUSE ${c.clause} [${c.form || ''}]`,
      appl ? `  Appliance types seen: ${appl}` : '',
      c.requirement ? `  Requirement: ${c.requirement}` : '',
      acc ? `  Accepted reply patterns:\n${acc}` : '',
      ib ? `  IB comments & closures:\n${ib}` : '',
      pit ? `  Common pitfalls:\n${pit}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

function renderStandard(passages) {
  if (!passages?.length) return '(no directly matching standard passage retrieved)';
  return passages.map((p, i) =>
    `[${i + 1}] ${p.source}${p.clauses?.length ? ` — clauses ${p.clauses.slice(0, 6).join(', ')}` : ''}\n${p.text}`
  ).join('\n\n');
}

// Sanitize prior turns the browser sent: only user/assistant text roles, capped.
function priorMessages(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
    .slice(-10) // keep the last ~5 exchanges
    .map((h) => ({ role: h.role, content: h.content.slice(0, 6000) }));
}

// Convert uploaded files (image / PDF) into Claude content blocks (vision / document).
export function fileBlocks(attachments) {
  return (attachments || []).map((a) => (a.media_type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } }
    : { type: 'image', source: { type: 'base64', media_type: a.media_type, data: a.data } }));
}

/**
 * answerWithLLM({ query, cards, standard, history }): Claude's grounded, anonymous
 * answer, using the SI 6464 STANDARD passages (authoritative) + the anonymized CORPUS
 * cards, continuing the prior conversation (history). Throws { code: 'ANON_BLOCK' } if
 * the output trips the anonymity guard (fail-closed).
 */
export async function answerWithLLM({ query, cards, standard, history, attachments }) {
  const context = renderContext(cards);
  const stdText = renderStandard(standard);
  const userText =
    `=== A) STANDARD — SI 6464 (authoritative requirement text) ===\n${stdText}\n\n` +
    `=== B) CORPUS — anonymized resolved history (how it's answered) ===\n${context}\n\n` +
    (attachments?.length ? `=== C) The client ATTACHED ${attachments.length} file(s) below — examine them and ground your answer in what they show (a drawing, document or photo), alongside the standard and corpus. ===\n\n` : '') +
    `---\nClient question: ${query}`;
  const content = [...fileBlocks(attachments), { type: 'text', text: userText }];
  const messages = [...priorMessages(history), { role: 'user', content }];
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM,
    messages,
  });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const hits = scanAnswer(text);
  if (hits.length) {
    const e = new Error(`LLM answer blocked by anonymity guard: ${hits.map((h) => h.match).join(', ')}`);
    e.code = 'ANON_BLOCK';
    throw e;
  }
  return { text, model: MODEL };
}

// Supported translation targets (code -> language name used in the prompt).
export const LANG_NAMES = { he: 'Hebrew', ru: 'Russian' };

/**
 * translate(text, lang): translate an already-generated (already anonymity-guarded)
 * English answer into natural professional `lang` (he/ru), preserving clause numbers,
 * standard references and markdown. Re-checked against the anonymity guard (fail-closed).
 */
export async function translate(text, lang = 'he') {
  const name = LANG_NAMES[lang] || 'Hebrew';
  const res = await getClient().messages.create({
    model: TRANSLATE_MODEL,
    max_tokens: 2000,
    system:
      `Translate the user's message into natural, professional ${name}. Rules:\n` +
      '- Keep ALL clause numbers and standard references EXACTLY as written, in Latin script ' +
      '(e.g. SI 6464, §7.2.1.5, EN 746-2, ISO, IEC, NFPA, ASME).\n' +
      '- Keep technical acronyms and abbreviations in their ORIGINAL ENGLISH form — do NOT ' +
      'translate or transliterate them (e.g. IAA, EOC, IB, HAC, RTO, PE, CS, NDT, ATEX, P&ID, ' +
      'PSV, PFD, MOC). Translate only the surrounding sentence around them.\n' +
      '- Keep engineering nouns accurate (boiler, furnace, water heater, corrosion allowance).\n' +
      '- Translate "design / designed / engineered" in the ENGINEERING sense (planning/calculation), ' +
      'NOT the aesthetic/styling sense:\n' +
      '    • Hebrew: use "תכנון / מתוכנן / מתוכננת" — NEVER "עיצוב / מעוצב / מעוצבת".\n' +
      '    • Russian: use "проектирование / спроектированный / проектный" (or "расчётный") — ' +
      'NEVER "дизайн / оформление / оформленный".\n' +
      '- Preserve the markdown formatting exactly (**bold**, bullet lists, line breaks).\n' +
      '- Translate the closing disclaimer line too.\n' +
      `Output ONLY the ${name} translation — no preamble, no explanation.`,
    messages: [{ role: 'user', content: String(text).slice(0, 8000) }],
  });
  const out = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const hits = scanAnswer(out);
  if (hits.length) {
    const e = new Error(`translation blocked by anonymity guard: ${hits.map((h) => h.match).join(', ')}`);
    e.code = 'ANON_BLOCK';
    throw e;
  }
  return { text: out, model: TRANSLATE_MODEL };
}

/**
 * genericizeQuestion(question): rewrite a client's question into a SHORT, generic, de-identified
 * FAQ-style version for PUBLIC display — stripping any company, site, plant, city, person, project,
 * drawing/document/order number, date, or unique quantity that could identify a project, keeping
 * only the technical/regulatory essence. This is the safety layer that lets real client questions
 * be shown publicly without leaking free-prose identifiers the regex scrubber can't catch.
 * Returns { text } ('' if it can't be safely generalized); throws ANON_BLOCK if the result still
 * trips the anonymity guard (fail-closed). Uses the cheap model.
 */
export async function genericizeQuestion(question) {
  const res = await getClient().messages.create({
    model: TRANSLATE_MODEL,
    max_tokens: 200,
    system:
      'You turn an engineer\'s question about SI 6464 (Israeli standard — natural-gas piping & ' +
      'industrial gas appliances) into a SHORT, GENERIC, anonymous FAQ entry for public display.\n' +
      'Rules:\n' +
      '- REMOVE every specific that could identify a project or party: company, client, site, plant, ' +
      'city/location, person, project name, drawing/document/order numbers, dates, and any unusual ' +
      'quantity unique to one project. Keep ONLY the general technical/regulatory question.\n' +
      '- KEEP clause numbers and standard references exactly (SI 6464, §7.2.1.5, EN, ISO, NFPA, ASME) ' +
      'and the general appliance type if mentioned (boiler, furnace, gas turbine, water heater, ' +
      'thermal oil heater).\n' +
      '- Output ONE clear general question, no preamble.\n' +
      '- Write it in the SAME language as the input (Hebrew or English).\n' +
      '- If the question cannot be generalized without revealing identifying specifics, output exactly: SKIP',
    messages: [{ role: 'user', content: String(question).slice(0, 1000) }],
  });
  const out = res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  if (!out || /^skip\b/i.test(out)) return { text: '' };
  const hits = scanAnswer(out);
  if (hits.length) { const e = new Error(`genericized question blocked by guard: ${hits.map((h) => h.match).join(', ')}`); e.code = 'ANON_BLOCK'; throw e; }
  return { text: out.slice(0, 300) };
}

export { MODEL };
