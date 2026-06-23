import xlsx from 'xlsx';
const files = process.argv.slice(2);
for (const f of files) {
  console.log("\n\n##### FILE:", f);
  let wb;
  try { wb = xlsx.readFile(f); } catch(e){ console.log("  ERR", e.message); continue; }
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    const ref = ws['!ref']; if(!ref){console.log("  sheet",sn,"(empty)");continue;}
    const range = xlsx.utils.decode_range(ref);
    console.log(`  --- sheet "${sn}"  rows=${range.e.r+1} cols=${range.e.c+1}`);
    const rows = xlsx.utils.sheet_to_json(ws, {header:1, defval:"", blankrows:true});
    // print first 12 rows, truncated cells
    rows.slice(0,12).forEach((r,i)=>{
      const cells = r.map(c=>String(c).replace(/\s+/g,' ').slice(0,40));
      console.log(`   [r${i}] `+cells.map((c,ci)=>`${String.fromCharCode(65+ci)}:${c}`).join(' | '));
    });
  }
}
