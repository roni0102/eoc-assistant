import xlsx from 'xlsx';
const f=process.argv[2];
const wb=xlsx.readFile(f);
const norm=v=>String(v??'').replace(/\s+/g,' ').trim();
console.log('SHEETS:', wb.SheetNames.join(' | '));
const hs=wb.Sheets['Header'];
if(hs){const rows=xlsx.utils.sheet_to_json(hs,{header:1,defval:''});
  console.log('\n=== HEADER SHEET ==='); rows.forEach((r,i)=>{const t=r.map(norm).filter(Boolean).join(' || ');if(t)console.log('r'+i,t.slice(0,160));});}
const rb=wb.Sheets['Report Body'];
if(rb){const rows=xlsx.utils.sheet_to_json(rb,{header:1,defval:''});
  const leg=rows.findIndex(r=>norm(r[0])==='#');
  console.log('\n=== REPORT BODY legend row',leg,'===');
  console.log(rows[leg].slice(0,12).map((c,i)=>String.fromCharCode(65+i)+'='+norm(c)).filter(x=>!/=$/.test(x)).join('  '));
  let shown=0;
  for(let i=leg+1;i<rows.length && shown<8;i++){const a=norm(rows[i][0]);
    if(/^7(\.\d+)+/.test(a)){const r=rows[i];
      console.log(`\n[${a}] REQ: ${norm(r[1]).slice(0,60)}`);
      console.log(`   D(answer): ${norm(r[3]).slice(0,70)} | E(verdict): ${norm(r[4])}`);
      for(let c=6;c<12;c++){const v=norm(r[c]);if(v)console.log(`   ${String.fromCharCode(65+c)}: ${v.slice(0,70)}`);}
      shown++;}}
  if(!shown)console.log('(no Ch.7; chapters:', [...new Set(rows.slice(leg+1).map(r=>norm(r[0]).match(/^\d+/)?.[0]).filter(Boolean))].join(','),')');
}
