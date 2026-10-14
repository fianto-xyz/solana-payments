import { formatUsdcAmount, isAmountInRange, parseUsdcAmount, U64_MAX } from './usdc.js';

describe('parseUsdcAmount', () => {
  it.each([
    ['10', 10_000_000n],
    ['10.5', 10_500_000n],
    ['0.000001', 1n],
    ['0.01', 10_000n],
    ['1000000', 1_000_000_000_000n],
    ['9999999.999999', 9_999_999_999_999n],
    ['007', 7_000_000n],
  ])('parses %s exactly', (input, expected) => {
    expect(parseUsdcAmount(input)).toBe(expected);
  });

  it.each(['', '1.', '.5', '1.0000001', '-1', '+1', ' 1', '1 ', '1e3', '0x10', '10000000', '1,5'])(
    'rejects %j',
    (input) => {
      expect(parseUsdcAmount(input)).toBeNull();
    },
  );
});

describe('formatUsdcAmount', () => {
  it.each([
    [10_000_000n, '10'],
    [10_500_000n, '10.5'],
    [1n, '0.000001'],
    [10_000n, '0.01'],
    [1_000_000_000_000n, '1000000'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatUsdcAmount(input)).toBe(expected);
  });

  it('round-trips with parseUsdcAmount', () => {
    for (const s of ['1', '0.1', '12.345678', '999999.99']) {
      expect(formatUsdcAmount(parseUsdcAmount(s) ?? -1n)).toBe(s);
    }
  });
});

describe('isAmountInRange', () => {
  const bounds = { min: 10_000n, max: 1_000_000_000_000n };
  it.each([
    [9_999n, false],
    [10_000n, true],
    [1_000_000_000_000n, true],
    [1_000_000_000_001n, false],
  ])('%s → %s', (amount, expected) => {
    expect(isAmountInRange(amount, bounds)).toBe(expected);
  });

  it.each([
    [0n, false],
    [1n, true],
    [U64_MAX, true],
    [U64_MAX + 1n, false],
  ])('defaults to 1 … u64 max: %s → %s', (amount, expected) => {
    expect(isAmountInRange(amount)).toBe(expected);
  });
});
