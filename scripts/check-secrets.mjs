// Fails on committed env files or long base58 strings (possible secret keys) outside test fixtures.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const bad = [];
for (const f of files) {
  if (/(^|\/)\.env/.test(f)) bad.push(`${f}: env file`);
  if (f.startsWith('src/testdata/') || f === 'pnpm-lock.yaml') continue;
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (/[1-9A-HJ-NP-Za-km-z]{64,}/.test(line)) bad.push(`${f}:${i + 1}: long base58 string`);
  });
}
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log('check-secrets: clean');
