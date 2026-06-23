// anonymize.mjs — single source of truth for the anonymity guarantee.
//
// THE ONE NON-NEGOTIABLE RULE: nothing in the knowledge base, and nothing the
// assistant ever returns, may name or hint at a past/current client, site,
// company, person, or document that could identify a source case.
//
// This module is used in TWO places so the guarantee is enforced by construction:
//   1. build_kb.mjs runs scrub() on every field as the KB is written.
//   2. anonymity_scan.mjs runs scan() on the finished KB (and on generated
//      answers) and FAILS THE BUILD on any hit.
// The scrubber and the scanner share the same rule set, so a value that scrub()
// cleans cannot later trip scan().

// --- 1. Explicit blocklist: identifiers harvested from the source files ----------
// Client / site / company names (EN + HE, including spelling variants).
export const CLIENT_NAMES = [
  'Tamborad', 'Tamboard', 'Tambour', 'Tambor', 'טמבורד', 'טמבור',
  'PowerGen', 'Powergen', 'Power Gen', 'פאוורגן', 'פאוור גן',
  'Ashkelon', 'אשקלון',
  'רפק אנרגיה', 'רפק', 'Rafac', 'Repak',
  'Orot Yosef', 'Orot yosef', 'אורות יוסף',
  'Geves Gesher', 'Geves', 'Gesher', 'גבס גשר', 'גבס', 'גשר',
  'Flocktex', 'Flocktech', 'פלוקטקס',
  'Negev Energy', 'Ashalim', 'Ashlim', 'נגב אנרגיה', 'אשלים',
  'Akko', 'עכו',
  // client/site names only. (Equipment-vendor brands like MAXON / Ozmaksan / BSH /
  // Granzbach / Fulton / Webster are NOT redacted — they identify equipment, not a
  // client.) 'Serafon' / 'Tzah Serafon' is a client/site name, so it stays.
  'Serafon', 'Tzah Serafon', 'צח שרפון',
  // recurring gas distributors / intermediaries that appear across many projects
  // (spelling variants), so the per-project harvest doesn't have to catch each
  'PAZGAS', 'Pazgas', 'Pazgaz', 'Paz Gas', 'פזגז', 'פז גז', 'פז',
  'Supergas', 'Amisragas', 'אמישראגז', 'סופרגז',
];

// Person / signer names (the inspector and any client signatory).
export const PERSON_NAMES = [
  'Shlomo Targan', 'S.Targan', 'S. Targan', 'שלמה טרגן', 'טרגן', 'Targan',
  'Roni korotkov', 'Roni Korotkov', 'רוני קורוטקוב', 'Korotkov',
];

// Exact document / form identifiers / project codes seen in the corpus.
export const DOC_IDS = [
  'AN13631.729', 'AM13681.636',
  'BTA-ESP-PFD-001', 'BTA-ESP', 'BTA',
  'BGG-ESP-DPD-001', 'BGG-ESP', 'BGG',
  'T1013-06-DWG-011', 'T1013',
  '46056', '46058', '14597',
];

// --- 2. Generic patterns: catch identifiers we have NOT seen before --------------
// These give the scan real teeth — they flag new client doc-IDs, emails, etc.
// that no blocklist could anticipate.
// NOTE: regex scrubbing catches STRUCTURED identifiers (codes, dates, paths,
// emails, phones). Free-prose identifiers (an unlisted site/person name embedded
// in a sentence) need an NER/LLM pass — that is the documented next hardening step.
// Order matters: paths and dates run before the generic doc-code rule.
export const PATTERNS = [
  // File paths — BACKSLASH only (real Windows paths in this corpus). Forward
  // slashes are almost always legitimate notation here (and/or, name/role/initials,
  // cold/hot) so they are NOT treated as paths, to avoid over-redacting prose.
  { name: 'path', re: /[\p{L}\p{N}_. -]+(?:\\[\p{L}\p{N}_. -]+)+/gu, repl: '[path]' },
  // Email addresses
  { name: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, repl: '[email]' },
  // Israeli phone numbers (0X / 05X — xxxxxxx, and +972 variants)
  { name: 'phone', re: /\b0\d{1,2}[-\s]?\d{7}\b|\b\+972[-\s]?\d{1,2}[-\s]?\d{7}\b/g, repl: '[phone]' },
  // Dates tied to a project: 14.04.15, 14/4/2015, 2015-04-14, and bare 6–8 digit dates (050814).
  // The lookarounds exclude SI 6464 clause paths like 7.2.1.10.22 (a "2.1.10" embedded in a
  // longer dotted number is a clause ref, not a date) — otherwise legitimate clause citations
  // get over-redacted.
  { name: 'date', re: /(?<![\d.])\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4}(?![\d.])|\b\d{4}-\d{2}-\d{2}\b|\b\d{6,8}\b/g, repl: '[date]' },
  // EOC reference codes: AN13631.729 / AM13681.636
  { name: 'eoc-ref', re: /\b[A-Z]{2}\d{4,}\.\d+\b/g, repl: '[document ref]' },
  // Engineering doc / drawing codes: any - _ / -joined alphanumeric token that
  // contains a run of 2+ digits. Catches multi-segment project codes in full:
  //   BTA-ESP-PFD-001_4, BTN-BPD-001, BTN-HAZ-403, CAL-003/004, T1013-06-DWG-011.
  // The lookahead requires a 2+ digit run, so hyphenated words ("as-made",
  // "spot-check", "re-approved") are NOT touched.
  //   A leading negative lookbehind exempts PUBLIC STANDARD references — a number
  //   right after a standards body (EN 746-2, ISO 12952-8, NFPA 37, UL 295, IEC 62337)
  //   is a standard, not a client doc ID, so it must not be redacted.
  { name: 'doc-id', re: /(?<!\b(?:EN|ISO|IEC|SI|NFPA|UL|ASME|DIN|API|BS|CEN|CSA|IGE|ASTM|AGA|UP)\s)\b(?=[A-Za-z0-9/_-]*\d{2,})[A-Za-z0-9]+(?:[-_/][A-Za-z0-9]+)+\b/g, repl: '[document ref]' },
  // Pure numeric codes with separators: 403-19-009, 003/004 (same standards-ref exemption).
  { name: 'num-code', re: /(?<!\b(?:EN|ISO|IEC|SI|NFPA|UL|ASME|DIN|API|BS|CEN|CSA|IGE|ASTM|AGA|UP)\s)\b\d{2,}(?:[-_/]\d{2,})+\b/g, repl: '[document ref]' },
];

// Build a single case-insensitive regex from a list of literal strings.
function literalsRe(list) {
  const escaped = list
    .slice()
    .sort((a, b) => b.length - a.length) // longest first so "BTA-ESP-PFD-001" wins over "BTA"
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Word-boundary the alternation so a short code like "BTA" matches only as a standalone
  // token — NOT the letters "bta" inside "obtain". Boundaries exclude Latin letters/digits:
  // this stops mid-word matches in ENGLISH text, while Hebrew entries stay effectively loose
  // (a Hebrew letter is not [A-Za-z0-9], so a Hebrew name still matches when glued to a
  // prefix like ב/ל/ה — important, since strict bounds there would MISS real names).
  return new RegExp('(?<![A-Za-z0-9])(' + escaped.join('|') + ')(?![A-Za-z0-9])', 'gi');
}

const NAME_RE = literalsRe([...CLIENT_NAMES, ...PERSON_NAMES, ...DOC_IDS]);

/**
 * scrub(text): remove every known identifier and generic-pattern match,
 * replacing it with a neutral placeholder. Used at ingestion time.
 */
export function scrub(text) {
  if (text == null) return text;
  let out = String(text);
  out = out.replace(NAME_RE, '[redacted]');
  for (const { re, repl } of PATTERNS) out = out.replace(re, repl);
  // neutralize any stray backslash left after the path rule (e.g. "Gas\air"
  // notation) so it cannot read as a path separator downstream.
  out = out.replace(/\\+/g, '/');
  // collapse repeated/adjacent placeholders and tidy whitespace
  out = out.replace(/(\[(?:redacted|document ref|path|date|email|phone)\][\s;,/-]*){2,}/g, (m) => m.match(/\[[^\]]+\]/)[0] + ' ')
           .replace(/[ \t]{2,}/g, ' ')
           .trim();
  return out;
}

// Defense-in-depth: the SCANNER is stricter than the scrubber. These broad
// structural detectors are INDEPENDENT of the scrub rules above — if scrub ever
// has a gap, one of these still fires and fails the build (green-but-leaking is
// the worst outcome). Scrubbed text must contain none of these.
const SCAN_EXTRA = [
  { name: 'path-sep', re: /\\[\p{L}\p{N}]/gu },                       // backslash path segment
  { name: 'date-like', re: /(?<![\d.])\d{1,2}[./]\d{1,2}[./]\d{2,4}(?![\d.])|\b\d{6,8}\b/g },
  { name: 'code-like', re: /(?<!\b(?:EN|ISO|IEC|SI|NFPA|UL|ASME|DIN|API|BS|CEN|CSA|IGE|ASTM|AGA|UP)\s)(?:\b[A-Za-z]{2,}[-_/]\d{2,}\b|\b\d{2,}[-_/]\d{2,}\b)/g },
];

/**
 * scrubWith(text, names): scrub using the static rules PLUS a dynamic, per-project
 * identifier set (client/site/person names harvested from that project's Header
 * sheet + folder name). Dynamic names are redacted FIRST, then the static scrub
 * runs. Tokens >=4 chars match as substrings (catches "Pazgaz" inside prose);
 * shorter tokens require word-ish boundaries to avoid over-redaction.
 */
export function scrubWith(text, names) {
  if (text == null) return text;
  let out = String(text);
  const list = [...(names || [])].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const n of list) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let re;
    if (/[A-Za-z]/.test(n)) {
      // Latin name → bound by Latin word chars at ANY length, so a harvested name never
      // redacts the letters inside an unrelated English word (e.g. "obtain", "confirmed").
      re = new RegExp('(?<![A-Za-z0-9])' + esc + '(?![A-Za-z0-9])', 'gi');
    } else {
      // Hebrew/other → keep loose matching for 4+ chars (catches prefixed forms like
      // באשלים), but bound very short tokens to avoid redacting common 1–3 letter words.
      re = n.length >= 4
        ? new RegExp(esc, 'gi')
        : new RegExp('(?<![\\p{L}\\p{N}])' + esc + '(?![\\p{L}\\p{N}])', 'giu');
    }
    out = out.replace(re, '[redacted]');
  }
  return scrub(out);
}

/**
 * scan(text): return an array of identifier hits. Empty array = clean.
 * Used by the anonymity test against the finished KB and any generated answer.
 */
export function scan(text) {
  if (text == null) return [];
  const s = String(text);
  const hits = [];
  for (const m of s.matchAll(NAME_RE)) {
    hits.push({ type: 'blocklist', match: m[0], index: m.index });
  }
  for (const { name, re } of [...PATTERNS, ...SCAN_EXTRA]) {
    for (const m of s.matchAll(re)) {
      hits.push({ type: name, match: m[0], index: m.index });
    }
  }
  return hits;
}

/**
 * scanAnswer(text): the guard for GENERATED LLM answers.
 *
 * The LLM only ever sees ALREADY-ANONYMIZED corpus records + the PUBLIC standard, so
 * it cannot reproduce a real client code/date/path — it never received one. Running the
 * structural code/date detectors on its prose only ever FALSE-positives on legitimate
 * technical content (clause numbers like 4.3.12, EN/ISO standard numbers, ratios like
 * 66/0). The genuine residual risk is a client/person NAME, plus contact details. So the
 * answer guard checks the blocklist names + emails/phones/paths/EOC-refs only.
 */
const ANSWER_PATTERNS = PATTERNS.filter((p) => ['email', 'phone', 'path', 'eoc-ref'].includes(p.name));
export function scanAnswer(text) {
  if (text == null) return [];
  const s = String(text);
  const hits = [];
  for (const m of s.matchAll(NAME_RE)) hits.push({ type: 'blocklist', match: m[0], index: m.index });
  for (const { name, re } of ANSWER_PATTERNS) for (const m of s.matchAll(re)) hits.push({ type: name, match: m[0], index: m.index });
  return hits;
}

/** Recursively scan any JSON value; returns [{path, hit}] for every identifier found. */
export function scanDeep(value, path = '$') {
  const found = [];
  if (typeof value === 'string') {
    for (const hit of scan(value)) found.push({ path, ...hit });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => found.push(...scanDeep(v, `${path}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) found.push(...scanDeep(v, `${path}.${k}`));
  }
  return found;
}
