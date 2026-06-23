// eoc.mjs — read & write an uploaded EOC workbook, a faithful Node/ExcelJS port of
// the eoc-fill skill's eoc_processor.py. Same fixed column map and ping-pong logic.
//
// Column layout (fixed):
//   A clause · B requirement · C client doc ref · D ITL results/remarks · E verdict
//   F EU/US path (read-only) · G+ ping-pong: G=client1, H=ITL1, I=client2, J=ITL2 …
//   (offset from G even → client column, odd → ITL column)
//
// Used ONLY for the premium per-client review. The uploaded file is processed in
// memory and never persisted or added to the public knowledge base.
import ExcelJS from 'exceljs';

const A = 1, B = 2, C = 3, D = 4, E = 5, F = 6, G = 7; // 1-based column indices
const norm = (v) => {
  if (v == null) return null;
  if (typeof v === 'object' && v.richText) v = v.richText.map((r) => r.text).join('');
  if (typeof v === 'object' && v.text) v = v.text;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s || null;
};
const isClientCol = (col) => (col - G) % 2 === 0; // even offset from G

function findReportBody(wb) {
  const sheets = wb.worksheets;
  const m = sheets.find((s) => /report|body|eoc/i.test(s.name));
  return m || sheets[0];
}
function findHeaderRow(ws) {
  for (let r = 1; r <= 10; r++) {
    for (let c = 1; c <= 10; c++) {
      const v = norm(ws.getCell(r, c).value);
      if (v && /requirement|clause|code|item/i.test(v)) return r;
    }
  }
  return 1;
}

/** readEOC(buffer) -> { sheetName, headerRow, type, rows:[...] } */
export async function readEOC(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = findReportBody(wb);
  const headerRow = findHeaderRow(ws);
  const maxCol = ws.columnCount;
  const CLAUSE = /^\d+(?:\.\d+)*$/; // real clause number — excludes "Chapter 4 …" banners
  const rows = [];
  let section = '';
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const clause = norm(ws.getCell(r, A).value);
    const requirement = norm(ws.getCell(r, B).value);
    if (!clause && !requirement) continue;
    if (!clause || !CLAUSE.test(clause)) { // section/banner row — remember as context, don't review
      if (requirement) section = requirement.slice(0, 80);
      continue;
    }
    const pingpong = [];
    for (let c = G; c <= Math.max(maxCol, G); c++) {
      const val = norm(ws.getCell(r, c).value);
      if (val != null) pingpong.push({ col: c, party: isClientCol(c) ? 'client' : 'ITL', content: val });
    }
    const verdict = norm(ws.getCell(r, E).value);
    const clientDoc = norm(ws.getCell(r, C).value);
    const itlRemarks = norm(ws.getCell(r, D).value);
    const last = pingpong[pingpong.length - 1];
    const lastClient = [...pingpong].reverse().find((p) => p.party === 'client');
    // consolidated client input for this row (doc ref + their latest reply)
    const clientAnswer = [clientDoc, lastClient && lastClient.content].filter(Boolean).join(' — ') || null;
    const closed = verdict && /^(pass|n\/?a)$/i.test(verdict);
    rows.push({
      row: r, clause, requirement, section,
      client_doc: clientDoc, itl_remarks: itlRemarks, verdict,
      path: norm(ws.getCell(r, F).value),
      pingpong,
      client_answer: clientAnswer,
      next_itl_col: last && last.party === 'client' ? last.col + 1 : (last ? null : G + 1),
      // review every row the client has answered (the tool gives ITL's assessment
      // whether or not a verdict already exists); blank rows are flagged 'missing'.
      reviewable: !!clientAnswer,
      answered: !!clientAnswer,
      status: closed ? 'closed'
        : !clientAnswer ? 'missing'
        : last && last.party === 'client' ? 'needs_itl_reply' : 'waiting_client',
    });
  }
  // EOC type from the dominant chapter (7 = Piping, 4–6 = IAA)
  const chapters = rows.map((x) => (x.clause || '').split('.')[0]).filter(Boolean);
  const piping = chapters.filter((c) => c === '7').length;
  const iaa = chapters.filter((c) => ['4', '5', '6'].includes(c)).length;
  const type = piping >= iaa ? 'Piping' : 'IAA';
  return { sheetName: ws.name, headerRow, type, rows };
}

/**
 * writeEOC(buffer, updates) -> annotated xlsx Buffer.
 * updates: [{ row, col_D, col_E, next_itl_col, itl_reply }]
 * Mirrors the skill's color-coded output (PASS green / FAILED red / N/A yellow).
 */
export async function writeEOC(buffer, updates) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = findReportBody(wb);
  const wrap = { wrapText: true, vertical: 'top' };
  const fill = (hex) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: hex } });
  for (const u of updates || []) {
    if (!u || !u.row) continue;
    if (u.col_D) { const cd = ws.getCell(u.row, D); cd.value = u.col_D; cd.alignment = wrap; }
    const v = (u.col_E || '').toUpperCase();
    if (v) {
      const ce = ws.getCell(u.row, E); ce.value = v;
      ce.alignment = { horizontal: 'center', vertical: 'center' };
      if (v === 'PASS') { ce.fill = fill('FFC6EFCE'); ce.font = { bold: true, color: { argb: 'FF375623' } }; }
      else if (v === 'FAILED' || v === 'FAIL') { ce.fill = fill('FFFFC7CE'); ce.font = { bold: true, color: { argb: 'FF9C0006' } }; }
      else if (v === 'N/A') { ce.fill = fill('FFFFEB9C'); ce.font = { bold: true, color: { argb: 'FF7D6608' } }; }
    }
    if (u.next_itl_col && u.itl_reply) {
      const cp = ws.getCell(u.row, u.next_itl_col);
      cp.value = u.itl_reply; cp.alignment = wrap; cp.font = { color: { argb: 'FF1F4E79' } };
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
