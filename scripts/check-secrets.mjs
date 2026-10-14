// Fails on committed env files, long base58 strings or 64-number byte arrays (possible secret keys) outside test fixtures.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const bad = [];
for (const f of files) {
  if (/(^|\/)\.env/.test(f)) bad.push(`${f}: env file`);
  if (f === 'src/testdata/devnet-rpc-errors.json' || f === 'pnpm-lock.yaml') continue;
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (/[1-9A-HJ-NP-Za-km-z]{64,}/.test(line)) bad.push(`${f}:${i + 1}: long base58 string`);
    if (/\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/.test(line)) bad.push(`${f}:${i + 1}: 64-number byte array (possible keypair)`);
  });
}
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log('check-secrets: clean');
