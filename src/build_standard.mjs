// build_standard.mjs — extract the SI 6464 standard documents into a retrievable
// index (data/standard.json), so the LLM can ground answers in the AUTHORITATIVE
// standard text ("what SI 6464 requires"), alongside the anonymized corpus
// ("how it's been answered").
//
// Sources: the published standard PDF + its amendments + ITL's short clarification
// memos (docx). The standard is public reference material — it contains no client
// identifiers — so it is indexed verbatim (not scrubbed).
//
// Run:  npm run build:standard
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mammoth from 'mammoth';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'data', 'standard.json');

export const STANDARD_ROOT = 'C:\\Users\\Roni_k\\Dropbox\\Standards\\SI\\6464\\6464 - 1.2017';

// Which files to ingest, with a generic source label (no client data in any of these).
const SOURCES = [
  { file: 'G_6464_2017.pdf', label: 'SI 6464 (2017) — main standard' },
  { file: '06464-00-00-1AMD_28-3-2017.docx', label: 'SI 6464 — Amendment (2017)' },
  { file: '6464 amendment 1- 2018.pdf', label: 'SI 6464 — Amendment 1 (2018)' },
  { file: '6464-GT2 (1) AMENDMENT 2.pdf', label: 'SI 6464 — Amendment 2 (gas turbines)' },
  { file: '6464-GT3_2025 -amend 3.pdf', label: 'SI 6464 — Amendment 3 (2025)' },
  { file: 'הסבר למסלול אמריקאי.docx', label: 'ITL clarification — US/EU (American) path' },
  { file: 'פרק 6.4.5.docx', label: 'ITL clarification — clause 6.4.5' },
  { file: 'צורך בדוגמית ריתוך.docx', label: 'ITL clarification — welding spot-check requirement' },
  { file: 'מכתב לדוודים לממונה על התקינה SIL 3.docx', label: 'ITL clarification — boilers / SIL 3' },
];

const norm = (s) => String(s ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

async function extract(file) {
  const full = path.join(STANDARD_ROOT, file);
  if (!fs.existsSync(full)) return null;
  const buf = fs.readFileSync(full);
  if (file.toLowerCase().endsWith('.pdf')) {
    // Extract in page batches, recreating the parser each batch so pdf.js frees
    // its per-page caches — a single long-lived parser leaks until the heap dies.
    const probe = new PDFParse({ data: buf });
    const info = await probe.getInfo();
    const total = info.total ?? info.numpages ?? 1;
    await probe.destroy?.();
    const BATCH = 25;
    let out = '';
    for (let first = 1; first <= total; first += BATCH) {
      const last = Math.min(first + BATCH - 1, total);
      const p = new PDFParse({ data: buf });
      const r = await p.getText({ first, last });
      out += (r.text || '') + '\n';
      await p.destroy?.();
    }
    return out;
  }
  if (file.toLowerCase().endsWith('.docx')) {
    const r = await mammoth.extractRawText({ buffer: buf });
    return r.value;
  }
  return null;
}

// Split text into ~1200-char windows on paragraph/sentence boundaries, with overlap,
// so a relevant passage is never cut in half across the retrieval boundary.
function chunkText(text, { size = 1200, overlap = 150 } = {}) {
  const clean = norm(text);
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + size, clean.length);
    if (end < clean.length) {
      // back up to the nearest paragraph/sentence/space break
      const slice = clean.slice(i, end);
      const br = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf('\n'));
      if (br > size * 0.5) end = i + br + 1;
    }
    const piece = clean.slice(i, end).trim();
    if (piece.length > 40) chunks.push(piece);
    // always move forward by at least (size - overlap) to avoid stalling
    const next = end - overlap;
    i = next > i ? next : i + size;
  }
  return chunks;
}

// Clause numbers referenced in a chunk (e.g. 7.2.1.5) — used for exact clause lookup.
const clausesIn = (t) => [...new Set((t.match(/\b\d{1,2}(?:\.\d{1,3}){1,4}\b/g) || []))].slice(0, 12);

async function main() {
  const chunks = [];
  let id = 0;
  for (const { file, label } of SOURCES) {
    process.stdout.write(`  extracting ${file} … `);
    let text;
    try { text = await extract(file); } catch (e) { console.log('ERR', e.message); continue; }
    if (!text) { console.log('skip (missing/unsupported)'); continue; }
    const pieces = chunkText(text);
    for (const piece of pieces) {
      chunks.push({ id: id++, source: label, clauses: clausesIn(piece), text: piece });
    }
    console.log(`${pieces.length} chunks`);
  }
  const std = {
    meta: { standard: 'SI 6464 (2017) + amendments', sources: SOURCES.length, generated_chunks: chunks.length },
    chunks,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(std));
  console.log(`\nStandard index written: ${OUT}`);
  console.log(`  chunks: ${chunks.length}`);
}

main();
