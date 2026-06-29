// One sandbox payment-form probe. Tries POST /payments/form and prints the response so we can
// confirm the exact schema + get a payment URL. Sandbox only — no real money.
//   node scripts/morning-pay-test.mjs
import 'dotenv/config';
import { apiFetch, env, baseUrl } from '../src/morning.mjs';

console.log(`env=${env()} base=${baseUrl()}`);

const body = {
  description: 'EOC Assistant — sandbox test (one question)',
  type: 320,                 // 320 = tax invoice/receipt (חשבונית מס/קבלה)
  lang: 'he',
  currency: 'ILS',
  vatType: 0,                // 0 = taxable (18% VAT)
  amount: 6,                 // ₪6 incl VAT (per-question tier)
  maxPayments: 1,
  client: { name: 'Test Customer', emails: ['test@example.com'], add: false },
  income: [{ description: 'EOC Assistant — one question', quantity: 1, price: 6, currency: 'ILS', vatType: 0 }],
  remarks: 'Sandbox connectivity test',
  successUrl: 'https://eoc-assistant.onrender.com/?paid=questions',
  failureUrl: 'https://eoc-assistant.onrender.com/?canceled=1',
  notifyUrl: 'https://eoc-assistant.onrender.com/pay/callback',
};

try {
  const r = await apiFetch('payments/form', { method: 'POST', body });
  console.log('RESPONSE:\n' + JSON.stringify(r, null, 2));
  const url = r.url || r?.data?.url;
  if (url) console.log('\n✓ PAYMENT URL: ' + url);
} catch (e) {
  console.error('payments/form FAILED: ' + (e?.message || e));
}
