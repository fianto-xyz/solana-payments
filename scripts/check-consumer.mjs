// Packs the package and loads it from a clean consumer WITHOUT @solana/subscriptions installed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), 'consumer-'));
const tgz = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: root, encoding: 'utf8' }).trim();
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', join(out, tgz),
  '@solana/kit@8.3.0', '@solana-program/token@0.16.1', '@solana-program/compute-budget@0.18.1'], { cwd: out, stdio: 'inherit' });
writeFileSync(join(out, 'esm.mjs'), `
import { buildPaymentTransaction, USDC_MINTS } from '@fianto/solana-payments';
import { parseUsdcAmount } from '@fianto/solana-payments/money';
if (typeof buildPaymentTransaction !== 'function' || parseUsdcAmount('1.5') !== 1500000n || !USDC_MINTS.devnet) process.exit(1);
console.log('esm ok');`);
writeFileSync(join(out, 'cjs.cjs'), `
const { verifyWalletSignature } = require('@fianto/solana-payments');
const { formatUsdcAmount } = require('@fianto/solana-payments/money');
if (typeof verifyWalletSignature !== 'function' || formatUsdcAmount(1500000n) !== '1.5') process.exit(1);
console.log('cjs ok');`);
execFileSync('node', ['esm.mjs'], { cwd: out, stdio: 'inherit' });
execFileSync('node', ['cjs.cjs'], { cwd: out, stdio: 'inherit' });
console.log(`tarball: ${join(out, tgz)}`);
