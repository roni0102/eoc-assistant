// corpus.mjs — discover and read every filled EOC in the archive by STRUCTURE,
// not by filename. This is what makes the product "the whole archive", not one form.
//
// An EOC sheet is recognised by: a header row whose first cell is "#", reply/comment
// columns (הערות ITL / תגובת|תשובות לקוח / Comments ITL / client reply / Results),
// and >=3 numbered data rows. Each discovered sheet is returned with a column map
// classifying every column as: document | requirement | submitted | ib | client.
import xlsx from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..', '..'); // "RK bold Finance ltd"

export const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

const RE_IB = /הערות\s*ITL|comments?\s*itl/i;
const RE_CLIENT = /תגוב[א-ת]*\s*לקוח|תשוב[א-ת]*\s*לקוח|client\s*reply/i;
const RE_SUBMIT = /מסמכים\s*ראשוניים|rev\s*0|results|client.*documentation|תשובת\s*לקוח/i;
const RE_DOC = /^(#|המסמך|document|doc\s*name)/i;
const RE_REQ = /description|requirement|דרישה/i;

// Read the list of all xlsx (relative paths) the survey produced.
export function readXlsxList(listRel = 'data/all_xlsx.txt') {
  const p = path.resolve(__dirname, '..', listRel);
  return fs.readFileSync(p, 'utf8').split('\n')
    .map((s) => s.trim().replace(/^\.\//, ''))
    .filter((s) => s.toLowerCase().endsWith('.xlsx') && !s.includes('~$'));
}

// Classify the columns of an EOC sheet using the header row and the row above it
// (forms put the column legend either on the "#" row or one row above).
function buildColumnMap(rows, hIdx) {
  const head = rows[hIdx].map(norm);
  const above = (rows[hIdx - 1] || []).map(norm);
  const map = [];
  for (let c = 0; c < Math.max(head.length, above.length); c++) {
    const label = [above[c], head[c]].filter(Boolean).join(' ');
    let role = null;
    if (c === 0) role = 'line';
    else if (RE_IB.test(label)) role = 'ib';
    else if (RE_CLIENT.test(label)) role = 'client';
    else if (RE_SUBMIT.test(label)) role = 'submitted';
    else if (c === 1 || RE_DOC.test(label)) role = 'document';
    else if (RE_REQ.test(label)) role = 'requirement';
    map.push({ col: c, role, label });
  }
  return map;
}

// Is this sheet an EOC? Return {hIdx, columns} or null.
function detectEOC(rows) {
  const hIdx = rows.findIndex((r) => norm(r[0]) === '#');
  if (hIdx < 0) return null;
  const columns = buildColumnMap(rows, hIdx);
  const hasReply = columns.some((c) => c.role === 'ib' || c.role === 'client' || c.role === 'submitted');
  const dataRows = rows.slice(hIdx + 1).filter((r) => /^\d+$/.test(norm(r[0]))).length;
  if (!hasReply || dataRows < 3) return null;
  return { hIdx, columns, dataRows };
}

/**
 * discover(): scan every xlsx, return the EOC sheets found.
 * Each entry: { rel, sheet, hIdx, columns, dataRows, rows }.
 */
export function discover(opts = {}) {
  const list = readXlsxList(opts.listRel);
  const found = [];
  for (const rel of list) {
    let wb;
    try { wb = xlsx.readFile(path.join(ROOT, rel)); } catch { continue; }
    for (const sheet of wb.SheetNames) {
      const ws = wb.Sheets[sheet];
      if (!ws['!ref']) continue;
      const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true });
      const eoc = detectEOC(rows);
      if (eoc) found.push({ rel, sheet, ...eoc, rows });
    }
  }
  return found;
}
