// audit.mjs — independent residual-leak sweep over all CORPUS-derived pattern
// strings (requirement / accepted_reply_patterns / ib_interaction_patterns /
// common_pitfalls). Uses risk regexes independent of the scrubber, plus shows a
// few sample clauses. Clause numbers in structural fields are excluded.
import fs from 'node:fs';
const kb = JSON.parse(fs.readFileSync('data/kb.json', 'utf8'));

const all = [];
for (const it of kb.items) {
  if (it.requirement_en) all.push(it.requirement_en);
  for (const p of it.accepted_reply_patterns || []) all.push(p.pattern);
  for (const p of it.ib_interaction_patterns || []) all.push(p.ib_comment);
  for (const p of it.common_pitfalls || []) all.push(p);
}

// sample: richest clauses (multi-project, with IB patterns)
const rich = kb.items.filter((i) => i.corpus_count >= 2 && i.ib_interaction_patterns.length)
  .sort((a, b) => b.corpus_count - a.corpus_count).slice(0, 4);
for (const it of rich) {
  console.log(`\n=== CLAUSE ${it.clause} [${it.form}] · ${it.corpus_count} projects ===`);
  (it.accepted_reply_patterns || []).slice(0, 2).forEach((p) => console.log(`  ACC[${p.frequency}${p.is_dominant ? '*' : ''}] ${p.pattern.slice(0, 80)}`));
  (it.ib_interaction_patterns || []).slice(0, 3).forEach((p) => console.log(`  IB[${p.frequency}/${p.resolution}] ${p.ib_comment.slice(0, 80)}`));
}

const RISK = [
  ['backslash', /\\/],
  ['bare-date', /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b|\b\d{6,8}\b/],
  ['code-ish', /\b[A-Za-z]{2,}[-_]\d{2,}\b|\b\d{2,}[-_/]\d{2,}\b/],
];
console.log('\n===== RESIDUAL LEAK AUDIT over', all.length, 'corpus strings =====');
let any = false;
for (const [name, re] of RISK) {
  const hits = all.filter((s) => re.test(s));
  if (hits.length) { any = true; console.log(`! ${name}: ${hits.length}`); hits.slice(0, 5).forEach((h) => console.log('    ', h.slice(0, 80))); }
}
if (!any) console.log('clean: no paths / dates / codes in any corpus string');
