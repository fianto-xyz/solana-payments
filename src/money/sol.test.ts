import { formatSol } from './sol.js';

describe('formatSol', () => {
  it.each([
    [0n, '0'],
    [10_000n, '0.00001'],
    [1_000_000_000n, '1'],
    [1_500_000_000n, '1.5'],
    [1n, '0.000000001'],
  ])('renders %s lamports as %s SOL', (lamports, expected) => {
    expect(formatSol(lamports)).toBe(expected);
  });
});
