import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(import.meta.dirname, '..', 'dist');

describe.runIf(existsSync(dist))('built dist/', () => {
  const files = existsSync(dist) ? readdirSync(dist) : [];

  it('has no source maps', () => {
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
  });

  it.each(files.filter((f) => /\.(c?js)$/.test(f)))('%s uses no Node-only API', (f) => {
    const code = readFileSync(join(dist, f), 'utf8');
    expect(code).not.toMatch(/\bBuffer\b/);
    expect(code).not.toMatch(/\bprocess\./);
    expect(code).not.toMatch(/require\(["']node:|from ["']node:/);
  });
});
