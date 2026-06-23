// archive.mjs — discovery + per-project identifier harvesting over the REAL ITL
// archive (the CH4 completed-works corpus). Full SI 6464 Inspection Report format.
//
// Two jobs:
//   1. discoverCompleted() — find the latest-revision EOC workbook per leaf folder
//      under "2. עבודות גמורות" (completed works), so we ingest closed items.
//   2. harvestIdentifiers(wb, projectFolder) — pull every client/site/person token
//      out of the Header sheet + folder name, to build a PER-PROJECT blocklist.
//      The Header sheet is NEVER ingested into the KB — only mined for redaction.
import xlsx from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';

export const ARCHIVE_ROOT =
  'C:\\Users\\Roni_k\\Dropbox\\CH4 eng & consultants\\ITL\\פרוייקטים';
export const COMPLETED = path.join(ARCHIVE_ROOT, '2. עבודות גמורות', 'G 1. Customer');

export const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// recursively list .xlsx under a dir
function listXlsx(dir) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listXlsx(p));
    else if (e.name.toLowerCase().endsWith('.xlsx') && !e.name.startsWith('~$')) out.push(p);
  }
  return out;
}

// parse a revision number from a filename (max wins). "rev 4", "Rev 4", "rev2.1", "_R1"
function revOf(name) {
  const m = name.match(/\brev\.?\s*([0-9]+(?:\.[0-9]+)?)/i) || name.match(/_R(?:ev)?\s*([0-9]+)/i);
  return m ? parseFloat(m[1]) : -1;
}
const isDraft = (name) => /draft|טיוטה/i.test(name);

/**
 * discoverCompleted({limit}): for each completed project, group its EOC files by
 * leaf folder (Piping / IAAs/<appliance> / …) and keep the latest non-draft rev.
 * Returns [{ project, file, leaf }].
 */
export function discoverCompleted({ limit } = {}) {
  let projects;
  try { projects = fs.readdirSync(COMPLETED, { withFileTypes: true }); } catch { return []; }
  projects = projects.filter((e) => e.isDirectory()).map((e) => e.name);
  if (limit) projects = projects.slice(0, limit);

  const picks = [];
  for (const project of projects) {
    const eocDir = path.join(COMPLETED, project, '3. EOCs');
    const files = listXlsx(eocDir);
    // group by leaf folder (the directory the file sits in)
    const byLeaf = new Map();
    for (const f of files) {
      const leaf = path.dirname(f);
      if (!byLeaf.has(leaf)) byLeaf.set(leaf, []);
      byLeaf.get(leaf).push(f);
    }
    for (const [leaf, fs_] of byLeaf) {
      // prefer highest rev, non-draft; tie-break on filename length (fuller)
      const best = fs_.slice().sort((a, b) => {
        const an = path.basename(a), bn = path.basename(b);
        const ad = isDraft(an) ? 1 : 0, bd = isDraft(bn) ? 1 : 0;
        if (ad !== bd) return ad - bd;
        return revOf(bn) - revOf(an);
      })[0];
      picks.push({ project, file: best, leaf: path.relative(eocDir, leaf) || '.' });
    }
  }
  return picks;
}

// tokens we must NOT blocklist (too generic — would nuke real prose).
const GENERIC = new Set([
  'the', 'and', 'of', 'for', 'ltd', 'ltd.', 'inc', 'co', 'company', 'israel', 'isra',
  'piping', 'iaa', 'iaas', 'eoc', 'rev', 'report', 'project', 'title', 'gas', 'natural',
  'steam', 'boiler', 'boilers', 'turbine', 'turbines', 'thru', 'through', 'plant', 'site',
  'facility', 'station', 'renewal', 'new', 'system', 'systems', 'industrial', 'standard',
  'inspection', 'body', 'product', 'testing', 'date', 'number', 'status', 'pages',
  'inspector', 'applicant', 'client', 'participants', 'name', 'address', 'scope', 'works',
  'general', 'description', 'requirement', 'requirements', 'test', 'method', 'object',
  'meet', 'does', 'pass', 'fail', 'verdict', 'serviceability', 'approval',
  // appliance / equipment / process words — these describe the EOC, they do NOT
  // identify a client or location, so they must NEVER be redacted.
  'burner', 'burners', 'furnace', 'furnaces', 'kiln', 'kilns', 'oven', 'ovens',
  'dryer', 'dryers', 'heater', 'heaters', 'engine', 'engines', 'oxidizer', 'oxidiser',
  'rto', 'thermal', 'oil', 'water', 'combustion', 'train', 'trains', 'chimney', 'flue',
  'appliance', 'appliances', 'iaa', 'iaas', 'catalog', 'catalogue', 'certificate',
  'certificates', 'compliance', 'energy', 'engineering', 'hospital', 'quarry', 'plain',
  'behalf', 'process', 'reply', 'replies', 'folder', 'data', 'customer',
  'בע"מ', 'גז', 'טבעי', 'חידוש', 'מתקן', 'תחנת', 'מערכת', 'פרויקט', 'דוד', 'דוודים', 'צנרת',
  'מבער', 'מבערים', 'תנור', 'תנורים', 'מייבש', 'מנוע', 'מחמם', 'דוודי', 'קיטור', 'ארובה',
]);

// Header cells that carry CLIENT/SITE/PERSON identifiers — strictly the identity
// rows. Description / scope / verdict-legend rows are excluded (generic prose that
// would otherwise pollute the blocklist and over-redact the corpus).
const ID_LABELS = /project title|applicant|client'?s? participants/i;

/**
 * harvestIdentifiers(wb, projectFolder): return a Set of identifier strings
 * (phrases + tokens) for this project, mined from the Header sheet + folder name.
 */
export function harvestIdentifiers(wb, projectFolder) {
  const ids = new Set();
  const add = (s) => {
    const t = norm(s);
    if (t.length >= 2) ids.add(t);
  };
  // 1) folder name → phrase + tokens
  collectPhrase(projectFolder, ids);

  const hs = wb.Sheets['Header'];
  if (hs) {
    const rows = xlsx.utils.sheet_to_json(hs, { header: 1, defval: '' });
    for (const r of rows) {
      const label = norm(r[0]);
      const isIdRow = ID_LABELS.test(label);
      // signer/participant names live in cols B–E of identifier rows
      for (let c = 1; c < r.length; c++) {
        const val = norm(r[c]);
        if (!val) continue;
        if (isIdRow) collectPhrase(val, ids);
      }
    }
  }
  return ids;
}

// split a value into useful identifier phrases + tokens, dropping generic words
function collectPhrase(value, ids) {
  const v = norm(value);
  if (!v) return;
  // keep meaningful comma/paren/dash-separated chunks as phrases
  for (const chunk of v.split(/[,()–\-\/|]+/)) {
    const c = norm(chunk);
    if (c.length >= 3 && !isAllGeneric(c)) ids.add(c);
    for (const tok of c.split(/\s+/)) {
      const t = tok.replace(/^["'“]+|["'”.]+$/g, '');
      if (t.length >= 3 && !GENERIC.has(t.toLowerCase()) && !/^\d+$/.test(t)) ids.add(t);
    }
  }
}
function isAllGeneric(phrase) {
  const words = phrase.toLowerCase().split(/\s+/);
  return words.every((w) => GENERIC.has(w) || /^\d+$/.test(w) || w.length < 3);
}

export { listXlsx };
