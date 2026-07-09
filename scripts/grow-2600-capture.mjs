// Capture the sandbox clearing error (2600) for Grow/Morning support. Auths (proves we reach
// clearing), sends a payment-form request, and prints the request summary + RAW response.
// Prints the API Key ID (identifies the sandbox account — OK to show) but NEVER the secret.
//   node scripts/grow-2600-capture.mjs
import 'dotenv/config';
import { getToken, baseUrl, env } from '../src/morning.mjs';

const keyId = process.env.GREENINVOICE_API_KEY_ID || '(unset)';
const ts = new Date().toISOString();
const req = { tier: 'Full EOC review', amountInclVat: 103, vatRate: '18%', currency: 'ILS' };

let token = '';
try { token = await getToken(); } catch (e) { console.log(JSON.stringify({ ts, env: env(), authError: String(e.message) })); process.exit(1); }

const body = {
  description: 'EOC Assistant — Full EOC review', type: 320, lang: 'he', currency: 'ILS', vatType: 0,
  amount: 103, maxPayments: 1,
  client: { name: 'Test Customer', emails: ['test@example.com'], add: false },
  income: [{ description: 'EOC Assistant — Full EOC review', quantity: 1, price: 103, currency: 'ILS', vatType: 0 }],
  remarks: 'Sandbox capture for enabling the test clearing terminal',
};
const r = await fetch(baseUrl() + 'payments/form', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const status = r.status;
const raw = await r.text();
console.log(JSON.stringify({ ts, env: env(), base: baseUrl(), keyId, authOk: !!token, request: req, httpStatus: status, rawResponse: raw }, null, 2));
