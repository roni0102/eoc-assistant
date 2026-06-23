// retrieve.mjs — retrieval over the knowledge base.
//
// Two paths, per the brief:
//   1. exact line-number fast path ("line 6", "6", "סעיף 6")
//   2. bilingual (EN/HE) lexical search over the line records.
// The corpus is small (37 lines), so transparent lexical scoring beats an
// embedding index here — it's deterministic, offline, and easy to audit. The
// retrieve() contract is embedding-ready: swap the scorer later without touching
// the backend.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_PATH = path.resolve(__dirname, '..', 'data', 'kb.json');

let KB = null;
export function loadKB() {
  if (!KB) KB = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
  return KB;
}

// Exact (or nearest-ancestor) corpus record for a clause — used by the premium review.
let CLAUSE_IDX = null;
export function getClause(clause) {
  const kb = loadKB();
  if (!CLAUSE_IDX) { CLAUSE_IDX = new Map(); for (const it of kb.items) CLAUSE_IDX.set(it.clause || it.line, it); }
  if (CLAUSE_IDX.has(clause)) return CLAUSE_IDX.get(clause);
  // fall back to the nearest ancestor clause (e.g. 7.2.1.10.28 -> 7.2.1.10 -> 7.2.1 …)
  let c = String(clause);
  while (c.includes('.')) { c = c.replace(/\.\d+$/, ''); if (CLAUSE_IDX.has(c)) return CLAUSE_IDX.get(c); }
  return null;
}

const STD_PATH = path.resolve(__dirname, '..', 'data', 'standard.json');
let STD = null;
export function loadStandard() {
  if (STD === null) {
    try { STD = JSON.parse(fs.readFileSync(STD_PATH, 'utf8')); }
    catch { STD = { chunks: [] }; } // standard index optional — degrade gracefully
  }
  return STD;
}

const tokenize = (s) =>
  String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);

// EN<->HE alias bridge. The checklist text is mostly English, so a Hebrew-speaking
// client's domain terms would otherwise miss. This compact map expands query
// tokens across languages. It is a STOPGAP for bilingual retrieval — replace with
// bilingual embeddings / an LLM phrasing pass when the API key is wired.
const ALIAS_GROUPS = [
  ['gassing', 'הגפה', 'הגזה'], ['venting', 'אוורור', 'שחרור'], ['gas', 'גז'],
  ['piping', 'צנרת', 'צינור'], ['wall', 'thickness', 'עובי', 'דופן'],
  ['cathodic', 'protection', 'קטודית', 'הגנה'], ['earthing', 'earth', 'הארקה'],
  ['welding', 'weld', 'ריתוך'], ['stress', 'מאמצים'], ['ventilation', 'אוורור'],
  ['fire', 'אש', 'כיבוי'], ['drawing', 'layout', 'תכנית', 'שרטוט'],
  ['procedure', 'נוהל', 'נהלים'], ['emergency', 'חירום'], ['shutdown', 'הפסקה', 'כיבוי'],
  ['training', 'הדרכה', 'הכשרה'], ['detector', 'detectors', 'גלאי', 'גלאים'],
  ['maintenance', 'אחזקה', 'תחזוקה'], ['electrical', 'חשמל'], ['signature', 'signed', 'חתימה', 'חתום'],
  ['document', 'documents', 'list', 'מסמך', 'מסמכים', 'רשימת'],
];
const ALIAS = new Map();
for (const g of ALIAS_GROUPS) for (const w of g) ALIAS.set(w, g);
function expand(tokens) {
  const out = new Set(tokens);
  for (const t of tokens) if (ALIAS.has(t)) for (const a of ALIAS.get(t)) out.add(a);
  return out;
}

// Detect an appliance type named in the query (EN/HE), to focus IAA answers.
const APPLIANCE_Q = [
  [/steam\s*boiler|מכון\s*קיטור|דוד\s*קיטור/i, 'steam boiler'],
  [/\bboiler\b|\bדוד(?:ים)?\b|קיטור|דוודי/i, 'boiler'],
  [/thermal\s*oil|oil\s*heater|שמן\s*תרמי/i, 'thermal oil heater'],
  [/gas\s*turbine|\bturbine|\bGT\b|טורבינ/i, 'gas turbine'],
  [/\bengine|מנוע/i, 'engine'],
  [/\bdryer|מייבש/i, 'dryer'],
  [/furnace|\bkiln|\boven|תנור/i, 'furnace'],
  [/water\s*heater|מחמם\s*מים|דוד\s*מים/i, 'water heater'],
  [/RTO|oxidi[sz]er|חמצון/i, 'thermal oxidizer (RTO)'],
];
export function detectAppliance(q) {
  for (const [re, label] of APPLIANCE_Q) if (re.test(String(q))) return label;
  return null;
}

// Pull an explicit SI 6464 clause out of a query, if present.
// Accepts "7.2.1.5", "clause 7.2", "סעיף 7.2.1", or a bare dotted clause.
export function parseClause(q) {
  const m = String(q).match(/(?:clause|section|סעיף|item|#)?\s*\.?\s*(\d+(?:\.\d+)+)\b/i)
    || String(q).trim().match(/^(\d+(?:\.\d+)+)$/);
  return m ? m[1] : null;
}

function searchableText(it) {
  return [it.clause, it.line, it.document, it.section, it.form, it.requirement_he, it.requirement_en, it.standard_reply]
    .concat((it.accepted_reply_patterns || []).map((p) => p.pattern))
    .concat((it.ib_interaction_patterns || []).map((p) => p.ib_comment))
    .join(' ');
}

/**
 * retrieve(query, k): returns { mode, items }.
 *   mode = 'clause' (exact/prefix clause hit) | 'search' | 'none'
 */
export function retrieve(query, k = 4) {
  const kb = loadKB();
  const cl = parseClause(query);
  if (cl) {
    const exact = kb.items.find((it) => (it.clause || it.line) === cl);
    if (exact) return { mode: 'clause', items: [exact] };
    // prefix match: "7.2" -> all 7.2.x clauses
    const pref = kb.items.filter((it) => String(it.clause || it.line).startsWith(cl + '.'));
    if (pref.length) return { mode: 'clause', items: pref.slice(0, k) };
  }
  const qTokens = tokenize(query);
  if (!qTokens.length) return { mode: 'none', items: [] };
  const qset = expand(qTokens);
  const appliance = detectAppliance(query);
  const scored = kb.items.map((it) => {
    const toks = tokenize(searchableText(it));
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const q of qset) if (tf.has(q)) score += 1 + Math.min(tf.get(q), 3) * 0.2;
    // light boost when the document name itself matches
    for (const q of qset) if (tokenize(it.document).includes(q)) score += 1.5;
    // appliance focus: boost clauses observed for the named appliance (IAA Ch.4–6)
    if (appliance && (it.appliance_breakdown || []).some((a) => a.appliance === appliance)) score += 3;
    return { it, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length) return { mode: 'none', items: [] };
  return { mode: 'search', items: scored.slice(0, k).map((x) => x.it) };
}

/**
 * retrieveStandard(query, k): authoritative SI 6464 text passages relevant to the
 * query — exact clause match first, then bilingual lexical scoring. Returns the
 * top-k chunks { source, clauses, text } for grounding the LLM.
 */
export function retrieveStandard(query, k = 4) {
  const std = loadStandard();
  if (!std.chunks?.length) return [];
  const cl = parseClause(query);
  const qset = expand(tokenize(query));
  const scored = std.chunks.map((c) => {
    let score = 0;
    if (cl && c.clauses?.some((x) => x === cl || x.startsWith(cl + '.') || cl.startsWith(x + '.'))) score += 8;
    const toks = tokenize(c.text);
    const tf = new Set(toks);
    for (const q of qset) if (tf.has(q)) score += 1;
    return { c, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((x) => ({ source: x.c.source, clauses: x.c.clauses, text: x.c.text }));
}
