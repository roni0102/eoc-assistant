// Morning (Greeninvoice) connection test — proves the sandbox keys authenticate.
//   node scripts/morning-test.mjs
// Reads GREENINVOICE_* from .env (dotenv). Prints "sandbox auth OK" + token expiry, or the error.
import 'dotenv/config';
import { diagnose } from '../src/morning.mjs';

const d = await diagnose();
if (d.ok) {
  console.log(`✓ ${d.env} auth OK · base ${d.base} · token ${d.tokenPreview} · expires ${d.tokenExpiry}`);
} else {
  console.error(`✗ Morning auth FAILED (${d.env}): ${d.error}`);
  process.exit(1);
}
