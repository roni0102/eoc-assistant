// eval_runone.mjs — review ONE held-out EOC against the hold-out KB and score it.
// Invoked by eval.mjs as a child process with EOC_KB_PATH set to the hold-out KB.
//   node src/eval_runone.mjs <file.xlsx> <projectName>
// Prints one JSON line: { project, type, precision, recall, perSectionRecall, tp, fp, fn,
//   leakageCount, semanticEquivalence? }. The review grounds against EOC_KB_PATH (no leakage).
import fs from 'node:fs';
import { readEOC } from './eoc.mjs';
import { reviewEOC } from './review.mjs';
import { score, referenceFlag, leakageFlag } from './eval.mjs';

const file = process.argv[2], project = process.argv[3] || '';
const buf = fs.readFileSync(file);
const eoc = await readEOC(buf);

// reference = every reviewable clause row (its IB-comment status is read by referenceFlag)
const refRows = eoc.rows.filter((r) => r.clause && r.requirement);
const refByRow = new Map(refRows.map((r) => [r.row, r]));

// run the engine (it predicts which rows the IB will comment on)
const rep = await reviewEOC({ type: eoc.type, rows: eoc.rows, limit: 1000 });

const s = score(refRows, rep.items);

// leakage: engine reproduced an item-specific fact that's in the reference but not the requirement
let leakageCount = 0;
for (const it of rep.items) if (leakageFlag(it, refByRow.get(it.row))) leakageCount++;

// optional semantic-equivalence judge on matched items (EOC_EVAL_SEMANTIC=1) — needs the LLM
let semanticEquivalence = null;
if (process.env.EOC_EVAL_SEMANTIC === '1') {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const cl = new Anthropic();
    const matched = rep.items.filter((it) => (it.readiness === 'NEEDS_ATTENTION' || it.readiness === 'MISSING') && referenceFlag(refByRow.get(it.row) || {}));
    let same = 0, n = 0;
    for (const it of matched.slice(0, 40)) {
      const ref = refByRow.get(it.row);
      const refTxt = (ref.itl_remarks || '') + ' ' + (ref.pingpong || []).filter((p) => p.party === 'ITL').map((p) => p.content).join(' ');
      const r = await cl.messages.create({ model: process.env.EOC_MODEL || 'claude-opus-4-8', max_tokens: 5,
        system: 'Answer only YES or NO. Are these two inspection-body comments asking for substantially the SAME thing (same missing evidence/action)? Ignore wording and language.',
        messages: [{ role: 'user', content: `A (engine): ${it.ib_expectations} ${it.suggested_fix}\nB (reference): ${refTxt}` }] });
      const ans = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('').toUpperCase();
      n++; if (ans.includes('YES')) same++;
    }
    semanticEquivalence = n ? same / n : null;
  } catch (e) { process.stderr.write('[runone] semantic judge skipped: ' + (e?.message || e) + '\n'); }
}

console.log(JSON.stringify({ project, type: eoc.type, ...s, leakageCount, semanticEquivalence }));
