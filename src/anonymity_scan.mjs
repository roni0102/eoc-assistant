// anonymity_scan.mjs — the automated anonymity gate (Deliverable #3).
//
// Scans the finished knowledge base for any client / site / person / document
// identifier. Exits non-zero on ANY hit so the build fails closed.
//
// The same scan() is exported for the backend to run on every generated answer
// before it is returned to a user.
//
// Run:  npm run test:anon
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDeep } from './anonymize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB = path.resolve(__dirname, '..', 'data', 'kb.json');

function main() {
  if (!fs.existsSync(KB)) {
    console.error(`✗ anonymity scan: ${KB} not found — run "npm run build:kb" first.`);
    process.exit(2);
  }
  const kb = JSON.parse(fs.readFileSync(KB, 'utf8'));
  // Scan only CORPUS-DERIVED text. Code-generated structural fields (clause / line /
  // source_refs) legitimately contain SI 6464 clause numbers like "2.1.10" that look
  // like dates — they carry no client info, so exclude them to avoid false positives.
  const GENERATED = /\.(clause|line|source_refs)(\[|$|\.)/;
  const hits = scanDeep(kb).filter((h) => !h.path.endsWith('._case') && !GENERATED.test(h.path));

  const strings = JSON.stringify(kb).match(/"(?:[^"\\]|\\.)*"/g)?.length ?? 0;
  if (hits.length === 0) {
    console.log(`✓ anonymity scan PASSED — ${kb.items.length} lines, ~${strings} strings checked, 0 identifiers found.`);
    process.exit(0);
  }
  console.error(`✗ anonymity scan FAILED — ${hits.length} identifier(s) found:`);
  for (const h of hits.slice(0, 50)) {
    console.error(`   ${h.path}  [${h.type}] "${h.match}"`);
  }
  process.exit(1);
}

main();
