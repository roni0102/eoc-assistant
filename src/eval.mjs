// eval.mjs — honest hold-out evaluation harness for the review engine (Improvement B).
//
// For each held-out completed EOC:
//   1. rebuild the KB EXCLUDING that document's project (true hold-out — never score on a doc
//      that is in the corpus), write it to a temp file;
//   2. run the review against that held-out KB;
//   3. compare the engine's flags to the REFERENCE (the clauses the IB actually commented on);
//   4. score precision / recall / per-section recall, judge semantic equivalence on matched
//      items, and flag leakage (verbatim reproduction of item-specific facts).
//
// Usage:  EOC_EVAL_DOCS=3 node src/eval.mjs            (3 held-out docs, both types)
//         node src/eval.mjs --self-test                (run the pure-scoring unit tests only)
//
// Requires the Dropbox archive + a VALID ANTHROPIC_API_KEY (the review + the semantic judge
// both call the model). It does NOT touch the production KB (writes a temp hold-out KB).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(os.tmpdir(), 'eoc-eval');

// ---- pure scoring (unit-tested; no LLM, no IO) ------------------------------------------
const chapterOf = (clause) => String(clause || '').split('.')[0] || '?';
const isPass = (t) => /^(pass|closed|n\/?a|ok|accepted|אושר|סגור|תקין)\b/i.test(String(t || '').trim());

/** A reference IB comment exists on a row when the ITL wrote a substantive request (not a pass). */
export function referenceFlag(row) {
  const itl = String(row.itl_remarks || '');
  const ping = (row.pingpong || []).filter((p) => p.party === 'ITL').map((p) => p.content).join(' ');
  const text = (itl + ' ' + ping).trim();
  return text.length >= 8 && !isPass(text);
}
/** The engine flags a row when its readiness needs action. */
export const predictFlag = (item) => item && (item.readiness === 'NEEDS_ATTENTION' || item.readiness === 'MISSING');

/** score(refs, preds): refs/preds are Maps clause->bool-flagged. Returns P/R + per-chapter recall. */
export function score(refRows, predItems) {
  const ref = new Map(); // row -> {flagged, clause}
  for (const r of refRows) ref.set(r.row, { flagged: referenceFlag(r), clause: r.clause });
  const pred = new Map();
  for (const it of predItems) pred.set(it.row, { flagged: predictFlag(it), clause: it.clause });

  let tp = 0, fp = 0, fn = 0;
  const perCh = {}; // chapter -> {tp, fn}
  for (const [rowNo, rf] of ref) {
    const pf = pred.get(rowNo)?.flagged || false;
    const ch = chapterOf(rf.clause);
    perCh[ch] = perCh[ch] || { tp: 0, fn: 0 };
    if (rf.flagged && pf) { tp++; perCh[ch].tp++; }
    else if (rf.flagged && !pf) { fn++; perCh[ch].fn++; }
  }
  for (const [rowNo, pf] of pred) { if (pf.flagged && !(ref.get(rowNo)?.flagged)) fp++; }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const perSectionRecall = {};
  for (const [ch, v] of Object.entries(perCh)) perSectionRecall[ch] = v.tp + v.fn ? v.tp / (v.tp + v.fn) : 1;
  return { tp, fp, fn, precision, recall, perSectionRecall };
}

/** Leakage: the engine reproduced item-specific facts (numbers/codes) found in the reference but
 *  NOT derivable from the requirement text — a sign the test doc leaked into the corpus. */
export function leakageFlag(item, refRow) {
  const facts = (s) => new Set((String(s || '').match(/\b[A-Z]{2,}-?\d[\w.\-]*|\b\d{3,}[\w.\-]*/g) || []));
  const reqFacts = facts(refRow?.requirement);
  const refFacts = facts((refRow?.itl_remarks || '') + ' ' + (refRow?.pingpong || []).map((p) => p.content).join(' '));
  const genText = (item?.ib_expectations || '') + ' ' + (item?.suggested_fix || '');
  const genFacts = facts(genText);
  for (const f of genFacts) if (refFacts.has(f) && !reqFacts.has(f)) return true;
  return false;
}

// ---- self-test of the pure scoring ------------------------------------------------------
function selfTest() {
  const refRows = [
    { row: 1, clause: '4.2.1.1', itl_remarks: 'Please provide SIL determination per IEC 61511.', pingpong: [], requirement: 'SIL' },
    { row: 2, clause: '4.3.2', itl_remarks: 'PASS', pingpong: [], requirement: 'pipework' },
    { row: 3, clause: '7.2.1', itl_remarks: 'Provide wall-thickness calculation.', pingpong: [], requirement: 'wall thickness' },
    { row: 4, clause: '7.3.1', itl_remarks: 'closed', pingpong: [], requirement: 'supplier' },
  ];
  const preds = [
    { row: 1, clause: '4.2.1.1', readiness: 'MISSING', ib_expectations: 'Provide SIL docs.' }, // TP
    { row: 2, clause: '4.3.2', readiness: 'READY' },                                            // TN
    { row: 3, clause: '7.2.1', readiness: 'READY' },                                            // FN (missed)
    { row: 4, clause: '7.3.1', readiness: 'NEEDS_ATTENTION' },                                  // FP (ref closed)
  ];
  const s = score(refRows, preds);
  const ok = s.tp === 1 && s.fp === 1 && s.fn === 1 && Math.abs(s.precision - 0.5) < 1e-9 && Math.abs(s.recall - 0.5) < 1e-9;
  const leak = leakageFlag({ ib_expectations: 'see file BTA-12345' }, { requirement: 'generic', itl_remarks: 'ref BTA-12345 attached', pingpong: [] });
  console.log('self-test score:', JSON.stringify(s));
  console.log('self-test per-section recall ch7:', s.perSectionRecall['7']); // 0/2? row3 fn, row4 not-ref → ch7 recall = 0/1
  console.log('leakage detects item-specific code:', leak, '(want true)');
  console.log(ok && leak ? '✓ self-test PASSED' : '✗ self-test FAILED');
  return ok && leak;
}

// ---- live harness (needs archive + API key) ---------------------------------------------
async function runBenchmark(nDocs) {
  const { discoverCompleted } = await import('./archive.mjs');
  const picks = discoverCompleted({});
  // pick N held-out docs spread across both EOC types if possible
  const chosen = picks.slice(0, nDocs);
  fs.mkdirSync(TMP, { recursive: true });
  const results = [];
  for (const pick of chosen) {
    const kbOut = path.join(TMP, `kb-holdout.json`);
    process.stderr.write(`\n[eval] hold-out build excluding "${pick.project}" …\n`);
    execFileSync('node', [path.join(__dirname, 'build_kb.mjs')], {
      env: { ...process.env, EXCLUDE_PROJECTS: pick.project, EOC_KB_OUT: kbOut },
      stdio: ['ignore', 'ignore', 'inherit'], timeout: 600000,
    });
    // run the review against the held-out KB in a child process (clean module/KB cache)
    const out = execFileSync('node', [path.join(__dirname, 'eval_runone.mjs'), pick.file, pick.project], {
      env: { ...process.env, EOC_KB_PATH: kbOut }, maxBuffer: 64 * 1024 * 1024, timeout: 1200000,
    }).toString();
    try { results.push(JSON.parse(out)); } catch { process.stderr.write('[eval] runone parse failed\n'); }
  }
  report(results);
}

function report(results) {
  if (!results.length) { console.log('No results.'); return; }
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const P = avg(results.map((r) => r.precision)), R = avg(results.map((r) => r.recall));
  const leak = results.filter((r) => r.leakageCount > 0).length;
  console.log('\n===== HOLD-OUT BENCHMARK =====');
  for (const r of results) console.log(`  ${r.type}  P=${(r.precision * 100).toFixed(0)}%  R=${(r.recall * 100).toFixed(0)}%  (tp=${r.tp} fp=${r.fp} fn=${r.fn})  leakage=${r.leakageCount}`);
  console.log(`\n  AVERAGE  precision=${(P * 100).toFixed(1)}%  recall=${(R * 100).toFixed(1)}%`);
  console.log(`  docs with leakage: ${leak}/${results.length}  (discount those)`);
  console.log(`  targets: precision ≥98%, recall ≥90%, safety/statutory recall ≥90%`);
}

// Only run when invoked directly (so eval_runone.mjs can import the scoring functions).
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv[2] === '--self-test') selfTest();
  else await runBenchmark(parseInt(process.env.EOC_EVAL_DOCS || '2', 10));
}
