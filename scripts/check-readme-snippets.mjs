// Every ```ts block in README.md is written to .readme-snippets/ and typechecked against dist/.
// Mark a block ```ts no-check to skip it.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
if (blocks.length === 0) { console.error('README has no ts snippets'); process.exit(1); }
const dir = join(root, '.readme-snippets');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir);
blocks.forEach((b, i) => writeFileSync(join(dir, `snippet-${i}.ts`), `export {};\n${b}`));
writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', target: 'ES2023', lib: ['ES2024'], strict: true, noEmit: true, skipLibCheck: true, types: ['node'] },
  include: ['*.ts'],
}));
try {
  execFileSync('npx', ['tsc', '-p', join(dir, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
  console.log(`${blocks.length} README snippets typecheck`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
