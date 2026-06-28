// Append a bilingual "Cancellation of membership" page to the Purchasing Policy PDF.
// Idempotent: always builds from the .orig.pdf backup, writes the combined file.
//   node scripts/append-policy-clause.mjs
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const PUB = path.join(process.cwd(), 'public');
const ORIG = path.join(process.cwd(), 'scripts', 'purchasing-policy.orig.pdf'); // source backup (not served)
const OUT = path.join(PUB, process.argv[2] || 'purchasing-policy.pdf');

const INK = rgb(0.06, 0.12, 0.22);
const MUTED = rgb(0.3, 0.36, 0.45);

// Hebrew has no contextual shaping, so for a pure-Hebrew run we reverse the visual order.
// We keep the Hebrew text free of digits/Latin so a per-line reversal is correct.
const isHeb = (s) => /[֐-׿]/.test(s);
const revLine = (line) => [...line].reverse().join('');

const doc = await PDFDocument.load(fs.readFileSync(ORIG));
doc.registerFontkit(fontkit);
const reg = await doc.embedFont(fs.readFileSync('C:/Windows/Fonts/arial.ttf'), { subset: true });
const bold = await doc.embedFont(fs.readFileSync('C:/Windows/Fonts/arialbd.ttf'), { subset: true });

const tmpl = doc.getPage(0);
const { width, height } = tmpl.getSize();
const page = doc.addPage([width, height]);
const M = 56;
const maxW = width - 2 * M;
let y = height - M - 10;

// greedy word-wrap by measured width (works for LTR & Hebrew glyph widths)
function wrap(text, font, size) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(t, size) > maxW && cur) { lines.push(cur); cur = w; }
    else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
function paragraph(text, { font = reg, size = 11, gap = 5, color = INK, rtl = false, lead = 1.45 } = {}) {
  for (const ln of wrap(text, font, size)) {
    const draw = rtl ? revLine(ln) : ln;
    const x = rtl ? width - M - font.widthOfTextAtSize(draw, size) : M;
    page.drawText(draw, { x, y, size, font, color });
    y -= size * lead;
  }
  y -= gap;
}
const rule = () => { page.drawLine({ start: { x: M, y: y + 6 }, end: { x: width - M, y: y + 6 }, thickness: 0.7, color: rgb(0.8, 0.84, 0.9) }); y -= 10; };

// ---- English ----
paragraph('Cancellation of membership', { font: bold, size: 15, gap: 8 });
paragraph('You may cancel your monthly membership at any time. Cancellation requires at least two (2) weeks’ prior written notice. Your membership and its benefits remain active until the end of the notice period, after which no further charges are made; fees already paid are non-refundable.', { size: 11, gap: 16 });

rule();

// ---- Hebrew (RTL) — pure Hebrew, no digits/Latin so per-line reversal is correct ----
paragraph('ביטול מנוי', { font: bold, size: 15, gap: 8, rtl: true });
paragraph('ניתן לבטל את המנוי החודשי בכל עת. הביטול מחייב מתן הודעה מוקדמת בכתב של שבועיים לפחות. המנוי וההטבות יישארו פעילים עד תום תקופת ההודעה, ולאחר מכן לא יבוצעו חיובים נוספים. תשלומים ששולמו אינם מוחזרים.', { size: 11, rtl: true, lead: 1.6 });

fs.writeFileSync(OUT, await doc.save());
console.log(`✓ wrote ${path.basename(OUT)} — pages: ${doc.getPageCount()} (added 1 cancellation page)`);
