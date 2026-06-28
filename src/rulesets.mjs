// rulesets.mjs — domain rule sets for the EOC review engine.
//
// Purpose (Improvement A, items 1 & 5): give the engine a per-clause classification it does
// NOT depend on a stored corpus match for. Each rule encodes a recurring SI 6464 / statutory
// requirement, its severity, and the canonical IB request in BOTH languages (Hebrew first-class).
//
// The engine uses this to:
//   • tag a clause as safety-critical / statutory  → such a clause is NEVER left blank/READY
//     without explicit evidence (a blank safety-critical clause almost always carries a comment);
//   • supply the canonical IB request as grounding even when the corpus has no close example;
//   • generate the comment in the language the IB uses for that item.
//
// These are GENERIC standard/statutory requirements — no client, site or project is referenced,
// so nothing here affects the anonymity rule.

// severity: 'safety' (high-stakes engineering/safety), 'statutory' (law/regulation), 'standard'.
// match: { clauses:[prefixes], kw:[english keywords], kwHe:[hebrew keywords] } — any hit matches.
export const RULES = [
  {
    key: 'sil', severity: 'safety', topic: 'Functional safety / SIL (IEC 61508 / 61511)',
    match: { clauses: ['4.2.1.1', '4.2.1'], kw: ['sil', 'functional safety', 'safety integrity', 'iec 61508', 'iec 61511', 'sis', 'safety instrumented'], kwHe: ['בטיחות תפקודית', 'רמת שלמות', 'סיל'] },
    ib_en: 'Provide the functional-safety / SIL documentation: SIL determination and verification per IEC 61511 (LOPA or equivalent), the safety functions and their target SIL, proof-test intervals, and SIL-capability certificates for the SIS components.',
    ib_he: 'יש להגיש תיעוד בטיחות תפקודית / SIL: קביעת ואימות רמת SIL לפי IEC 61511 (LOPA או שקול), הגדרת פונקציות הבטיחות ורמת ה-SIL הנדרשת, מרווחי בדיקת הוכחה, ותעודות התאמת SIL לרכיבי מערכת הבטיחות (SIS).',
  },
  {
    key: 'risk', severity: 'safety', topic: 'Risk assessment (HAZID / HAZOP)',
    match: { clauses: ['4.2.1', '4.3.1', '4.5'], kw: ['risk assessment', 'hazid', 'hazop', 'management of change', 'moc'], kwHe: ['הערכת סיכונים', 'ניהול שינויים'] },
    ib_en: 'Provide the risk-assessment report (HAZID/HAZOP as applicable): the team and methodology, the hazards identified, the safeguards, and evidence that residual risk is acceptable.',
    ib_he: 'יש להגיש דו"ח הערכת סיכונים (HAZID/HAZOP לפי העניין): הרכב הצוות והמתודולוגיה, הסיכונים שזוהו, אמצעי ההגנה, והוכחה כי הסיכון הנותר מקובל.',
  },
  {
    key: 'burner', severity: 'safety', topic: 'Burner & combustion safety (BMS)',
    match: { clauses: ['4.3.5', '4.3.3', '4.3.4', '21'], kw: ['burner', 'combustion', 'flame', 'bms', 'burner management', 'purge', 'safety shut', 'ssov', 'assv', 'en 298', 'nfpa 86'], kwHe: ['מבער', 'בעירה', 'להבה', 'שטיפה', 'ניתוק בטיחות'] },
    ib_en: 'Provide the burner / combustion safety evidence: the burner management system (flame supervision per EN 298 / NFPA 86), the gas-train P&ID, the safety shut-off valves with proof-of-closure, and the start-up purge sequence.',
    ib_he: 'יש להגיש הוכחות בטיחות מבער/בעירה: מערכת ניהול המבער (פיקוח להבה לפי EN 298 / NFPA 86), תרשים ה-P&ID של רכבת הגז, שסתומי ניתוק בטיחות עם הוכחת סגירה, ורצף שטיפה (purge) בהתנעה.',
  },
  {
    key: 'hac', severity: 'safety', topic: 'Hazardous-area classification & Ex / electrical',
    match: { clauses: [], kw: ['hazardous area', 'area classification', 'hac', 'atex', 'explosive atmosphere', 'si 60079', '60079', 'ex equipment', 'zone 1', 'zone 2'], kwHe: ['סיווג אזורים', 'אטמוספירה נפיצה', 'ציוד אקס'] },
    ib_en: 'Provide the hazardous-area classification drawing (per SI 60079-10.1), the Ex-equipment certificates for equipment in the classified zones, and confirmation of electrical compliance for the classified area.',
    ib_he: 'יש להגיש תרשים סיווג אזורים מסוכנים (לפי ת"י 60079-10.1), תעודות ציוד Ex לציוד באזורים המסווגים, ואישור התאמה חשמלית לאזור המסווג.',
  },
  // --- statutory ---
  {
    key: 'pressure', severity: 'statutory', topic: 'Pressure vessel / boiler statutory inspection',
    match: { clauses: ['4.3.6'], kw: ['pressure vessel', 'boiler', 'steam', 'water-tube', 'fire-tube', 'autoclave'], kwHe: ['כלי לחץ', 'דוד', 'דוד קיטור', 'מיכל לחץ'] },
    ib_en: 'Provide the statutory pressure-vessel / boiler documentation: the pressure-vessel certificate and the authorised boiler inspector’s approval / periodic inspection per the applicable safety regulations.',
    ib_he: 'יש להגיש תיעוד סטטוטורי לכלי לחץ / דוד: תעודת כלי לחץ ואישור בודק דוודים מוסמך / בדיקה תקופתית לפי תקנות הבטיחות החלות.',
  },
  {
    key: 'electrical_law', severity: 'statutory', topic: 'Electrical-law compliance',
    match: { clauses: [], kw: ['electrical compliance', 'electrician', 'electricity law', 'electrical inspection', 'wiring diagram'], kwHe: ['חוק החשמל', 'חשמלאי', 'בדיקת חשמל', 'התאמה חשמלית'] },
    ib_en: 'Provide evidence of electrical compliance under the Electricity Law: an inspection certificate by a licensed electrical inspector / electrician for the installation.',
    ib_he: 'יש להגיש הוכחת התאמה לחוק החשמל: תעודת בדיקה של בודק/חשמלאי מוסמך עבור המתקן.',
  },
  {
    key: 'fire', severity: 'statutory', topic: 'Fire-service approval',
    match: { clauses: [], kw: ['fire service', 'fire department', 'firefighting', 'fire approval'], kwHe: ['כיבוי אש', 'כב"ה', 'אישור כיבוי'] },
    ib_en: 'Provide the Fire & Rescue Service approval for the installation.',
    ib_he: 'יש להגיש אישור שירותי הכבאות וההצלה למתקן.',
  },
  {
    key: 'periodic', severity: 'statutory', topic: 'Periodic inspection report',
    match: { clauses: [], kw: ['periodic inspection', 'surveillance', 'annual inspection', 'maintenance report'], kwHe: ['בדיקה תקופתית', 'בדיקה שנתית', 'דו"ח תחזוקה'] },
    ib_en: 'Provide the periodic / surveillance inspection report for the relevant approval stage.',
    ib_he: 'יש להגיש דו"ח בדיקה תקופתית / מעקב לשלב האישור הרלוונטי.',
  },
];

const hasHebrew = (s) => /[֐-׿]/.test(String(s || ''));

/** classify(clause, requirement) -> the matching rule (most specific clause first) or null. */
export function classify(clause, requirement) {
  const cl = String(clause || '');
  const text = String(requirement || '').toLowerCase();
  // 1) clause-prefix match wins (most specific)
  for (const r of RULES) {
    if ((r.match.clauses || []).some((p) => cl === p || cl.startsWith(p + '.'))) return r;
  }
  // 2) keyword match (EN + HE)
  for (const r of RULES) {
    if ((r.match.kw || []).some((k) => text.includes(k))) return r;
    if ((r.match.kwHe || []).some((k) => String(requirement || '').includes(k))) return r;
  }
  return null;
}

/** Grounding hint for one row: severity + the canonical IB request in the right language. */
export function ruleHint(clause, requirement) {
  const r = classify(clause, requirement);
  if (!r) return null;
  const he = hasHebrew(requirement);
  return { key: r.key, severity: r.severity, topic: r.topic, canonical_ib_request: he ? r.ib_he : r.ib_en, language: he ? 'he' : 'en' };
}

export const isCritical = (clause, requirement) => {
  const r = classify(clause, requirement);
  return !!r && (r.severity === 'safety' || r.severity === 'statutory');
};
