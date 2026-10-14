import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts', subscriptions: 'src/subscriptions/index.ts', money: 'src/money/index.ts' },
  format: ['esm', 'cjs'],
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  sourcemap: false,
  clean: true,
  external: [/^@solana\//, /^@solana-program\//],
});
