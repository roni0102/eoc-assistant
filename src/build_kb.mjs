// build_kb.mjs — corpus-aggregation ingestion over the REAL ITL archive
// (Deliverables #1, #2). Full SI 6464 Inspection Report format, keyed by clause.
//
// For every completed-works EOC (latest revision per leaf folder):
//   - harvest that project's identifiers from its Header sheet (never ingested),
//   - read the Report Body, keyed by SI 6464 clause (col A),
//   - mine the client answer (col D Results/Remarks) and the dated "Comments ITL"
//     columns (the IB rounds), anonymized via scrubWith(...projectIds),
//   - aggregate per clause across ALL projects into frequency-ranked patterns.
//
// Each project votes once per clause, so revisions don't inflate frequency.
//
// Run:  npm run build:kb            (all completed works)
//       npm run build:kb -- 5       (limit to first N projects, for a quick pilot)
import xlsx from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubWith, scrub } from './anonymize.mjs';
import { discoverCompleted, harvestIdentifiers, norm } from './archive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'data', 'kb.json');
const LIMIT = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;

// --- clustering (shared with the pattern aggregation) ---------------------------
const toks = (s) => new Set(norm(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1));
function sim(a, b) {
  const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
function cluster(votes, threshold = 0.5) {
  const clusters = [];
  for (const v of votes) {
    let best = null, bestS = 0;
    for (const c of clusters) { const s = sim(v.text, c.rep); if (s > bestS) { bestS = s; best = c; } }
    if (best && bestS >= threshold) { best.cases.add(v.case); if (v.text.length > best.rep.length) best.rep = v.text; }
    else clusters.push({ rep: v.text, cases: new Set([v.case]) });
  }
  return clusters.map((c) => ({ pattern: c.rep, frequency: c.cases.size }))
    .sort((a, b) => b.frequency - a.frequency || b.pattern.length - a.pattern.length);
}

// After scrubbing, is there too little real content left (mostly placeholders)?
function infoPoor(s) {
  const real = String(s).replace(/\[(document ref|redacted|path|date|email|phone)\]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
  return real.length < 6;
}
const isTrivial = (s) => {
  const t = norm(s).replace(/[V✓✔]/g, '').trim();
  return !t || /^(n\/?a|pass|fail|ok|see above|כנ"ל)$/i.test(t);
};

// --- Report Body parsing --------------------------------------------------------
const RE_REQ = /requirement/i, RE_RESULT = /results|remarks/i, RE_VERDICT = /verdict/i;
const RE_ITL = /comments?\s*itl|הערות\s*itl/i, RE_CLIENTREPLY = /client\s*reply|תגוב[א-ת]*\s*לקוח|תשוב[א-ת]*\s*לקוח/i;
const CLAUSE = /^\d+(?:\.\d+)+/; // 7.2.1.5 etc.

function classifyBody(legend) {
  const map = { req: 1, result: 3, verdict: 4, itl: [], client: [] };
  legend.forEach((cell, i) => {
    const t = norm(cell);
    if (RE_REQ.test(t)) map.req = i;
    else if (RE_RESULT.test(t)) map.result = i;
    else if (RE_VERDICT.test(t)) map.verdict = i;
    else if (RE_ITL.test(t)) map.itl.push(i);
    else if (RE_CLIENTREPLY.test(t)) map.client.push(i);
  });
  return map;
}

const chapterOf = (clause) => clause.split('.')[0];
const formOf = (ch) => (ch === '7' ? 'Piping' : (['4', '5', '6'].includes(ch) ? 'IAA' : `Chapter ${ch}`));

// Appliance type from the EOC file path (folder + filename). IAA clauses (Ch.4–6)
// and the appliance-specific chapters apply differently per appliance, so each
// observation is tagged with the appliance it came from. Order = most specific first.
const APPLIANCE_RULES = [
  [/steam\s*boiler|מכון\s*קיטור|דווד?\s*קיטור|דוד\s*קיטור/i, 'steam boiler'],
  [/aux\s*boiler|\bboiler\b|\bדוד(?:ים)?\b|קיטור|ytong|דוודי/i, 'boiler'],
  [/thermal\s*oil|oil\s*heater|שמן\s*תרמי/i, 'thermal oil heater'],
  [/gas\s*turbine|\bturbine|\bGT\b|טורבינ/i, 'gas turbine'],
  [/\bengine|מנוע/i, 'engine'],
  [/\bdryer|מייבש/i, 'dryer'],
  [/furnace|\bkiln|\boven|תנור/i, 'furnace'],
  [/water\s*heater|מחמם\s*מים|דוד\s*מים/i, 'water heater'],
  [/RTO|oxidi[sz]er|חמצון/i, 'thermal oxidizer (RTO)'],
  [/greenhouse|חממ/i, 'greenhouse heater'],
  [/fuel(?:ing)?\s*station|תחנת\s*תדלוק/i, 'fueling station'],
];
function applianceOf(filePath) {
  const p = String(filePath);
  // a Piping EOC is not an appliance
  if (/[\\/]Piping[\\/]|EOC\s*7|- Piping|צנרת/i.test(p) && !/IAA|boiler|turbine|דוד|טורב/i.test(p)) return null;
  for (const [re, label] of APPLIANCE_RULES) if (re.test(p)) return label;
  return null;
}

// --- ingest one EOC workbook ----------------------------------------------------
function ingestFile(file, project, store, globalIds) {
  let wb;
  try { wb = xlsx.readFile(file); } catch { return { ok: false }; }
  if (!wb.SheetNames.includes('Report Body')) return { ok: false, skipped: 'no-report-body' };
  // per-project identifiers UNION the global set (a name that is a participant in
  // one project but appears in another project's prose is still redacted).
  const ids = new Set([...harvestIdentifiers(wb, project), ...(globalIds || [])]);
  const rows = xlsx.utils.sheet_to_json(wb.Sheets['Report Body'], { header: 1, defval: '' });
  const leg = rows.findIndex((r) => norm(r[0]) === '#');
  if (leg < 0) return { ok: false, skipped: 'no-legend' };
  const col = classifyBody(rows[leg]);
  const appliance = applianceOf(file); // appliance type for this EOC, if any

  let items = 0;
  for (let i = leg + 1; i < rows.length; i++) {
    const r = rows[i];
    const clause = norm(r[0]);
    if (!CLAUSE.test(clause)) continue;          // skip chapter/section banners
    const requirement = norm(r[col.req]);
    if (!requirement) continue;
    const rec = store.clauses.get(clause) || {
      clause, form: formOf(chapterOf(clause)), requirement_reps: [],
      acc: [], ib: [], cases: new Set(), appliances: new Map(),
    };
    rec.cases.add(project);
    if (appliance) {
      if (!rec.appliances.has(appliance)) rec.appliances.set(appliance, new Set());
      rec.appliances.get(appliance).add(project);
    }
    rec.requirement_reps.push(requirement);       // scaffold text (standard, public)
    // accepted answer = client's result/remark when present and substantive
    const answer = norm(r[col.result]);
    if (answer && !isTrivial(answer)) {
      const s = scrubWith(answer, ids);
      if (!infoPoor(s)) rec.acc.push({ text: s, case: project });
    }
    // client reply columns, if any (some forms split answer/reply)
    for (const c of col.client) {
      const v = norm(r[c]);
      if (v && !isTrivial(v)) { const s = scrubWith(v, ids); if (!infoPoor(s)) rec.acc.push({ text: s, case: project }); }
    }
    // IB comments = each dated "Comments ITL" column
    for (const c of col.itl) {
      const v = norm(r[c]);
      if (v && !isTrivial(v)) { const s = scrubWith(v, ids); if (!infoPoor(s)) rec.ib.push({ text: s, case: project }); }
    }
    store.clauses.set(clause, rec);
    items++;
  }
  return { ok: true, items };
}

// pick the most representative (modal-ish) requirement wording for a clause
function repRequirement(reps) {
  if (!reps.length) return '';
  // choose the longest that shares tokens with the majority
  return scrub(reps.slice().sort((a, b) => b.length - a.length)[0]);
}

// --- orchestrate ----------------------------------------------------------------
function main() {
  const picks = discoverCompleted({ limit: LIMIT });
  const projects = new Set(picks.map((p) => p.project));
  console.log(`Discovered ${picks.length} latest-rev EOC files across ${projects.size} completed projects.`);

  // PASS 1 — harvest a GLOBAL identifier set from every project's Header sheet
  // (parse only the Header sheet to keep this pass cheap).
  const globalIds = new Set();
  let h = 0;
  for (const { file, project } of picks) {
    try {
      const wb = xlsx.readFile(file, { sheets: ['Header'] });
      for (const id of harvestIdentifiers(wb, project)) globalIds.add(id);
    } catch { /* unreadable — skip */ }
    if (++h % 25 === 0) console.log(`  [harvest] ${h}/${picks.length} (${globalIds.size} identifiers)`);
  }
  console.log(`Global identifier set: ${globalIds.size} names/tokens across all projects.`);

  // PASS 2 — ingest, scrubbing each file with per-project + global identifiers
  const store = { clauses: new Map() };
  let read = 0, ingested = 0, skipped = 0;
  for (const { file, project } of picks) {
    const res = ingestFile(file, project, store, globalIds);
    read++;
    if (res.ok) ingested++; else skipped++;
    if (read % 25 === 0) console.log(`  [ingest] ${read}/${picks.length} files (${store.clauses.size} clauses so far)`);
  }

  // aggregate
  const items = [];
  for (const rec of store.clauses.values()) {
    const acc = cluster(rec.acc); acc.forEach((p, i) => (p.is_dominant = i === 0));
    const ib = cluster(rec.ib);
    items.push({
      line: rec.clause, clause: rec.clause, form: rec.form,
      section: rec.form, document: '',
      requirement_en: repRequirement(rec.requirement_reps), requirement_he: '',
      standard_reply: '',
      accepted_reply_patterns: acc,
      ib_interaction_patterns: ib.map((p) => ({
        ib_comment: p.pattern, frequency: p.frequency,
        resolution: /item closed|closed|accepted|אושר|נסגר/i.test(p.pattern) ? 'accepted'
          : /condition|התנייה/i.test(p.pattern) ? 'accepted-with-condition' : 'comment-raised',
      })),
      common_pitfalls: ib.filter((p) => p.frequency >= 2).map((p) => p.pattern),
      corpus_count: rec.cases.size,
      // which appliance types this clause was observed for, and in how many projects
      appliance_breakdown: [...rec.appliances.entries()]
        .map(([appliance, set]) => ({ appliance, projects: set.size }))
        .sort((a, b) => b.projects - a.projects),
      source_refs: [`SI 6464 §${rec.clause}`, 'eoc-fill skill'],
    });
  }
  items.sort((a, b) => a.clause.localeCompare(b.clause, undefined, { numeric: true }));

  const kb = {
    meta: {
      standard: 'SI 6464 (2017)',
      form: 'Full Inspection Report (clause-keyed) — Piping (Ch.7) + IAA (Ch.4–6)',
      corpus_projects: projects.size,
      corpus_files: ingested,
      note: 'Reference guidance only — not a formal ITL determination.',
    },
    items,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(kb, null, 2));
  const withAcc = items.filter((i) => i.accepted_reply_patterns.length).length;
  const withIb = items.filter((i) => i.ib_interaction_patterns.length).length;
  console.log(`\nKB written: ${OUT}`);
  console.log(`  projects ingested:        ${projects.size}  (files: ${ingested}, skipped: ${skipped})`);
  console.log(`  distinct clauses:         ${items.length}`);
  console.log(`  clauses w/ accepted reply:${withAcc}`);
  console.log(`  clauses w/ IB patterns:   ${withIb}`);
}

main();
