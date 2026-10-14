import { computeFee } from './fee.js';

describe('computeFee', () => {
  it('takes nothing at zero bps', () => {
    expect(computeFee(10_000_000n, 0)).toEqual({
      feeBps: 0,
      feeAmount: 0n,
      totalAmount: 10_000_000n,
    });
  });

  it('adds the fee on top of the price, never out of it', () => {
    // 1 % of 10 USDC = 0.1 USDC; the recipient still receives the full 10.
    expect(computeFee(10_000_000n, 100)).toEqual({
      feeBps: 100,
      feeAmount: 100_000n,
      totalAmount: 10_100_000n,
    });
  });

  it('floors a fraction of a base unit, so a rounding difference never goes against the payer', () => {
    expect(computeFee(10_001n, 100).feeAmount).toBe(100n);
    expect(computeFee(99n, 1).feeAmount).toBe(0n);
  });

  it('handles the top of the range without losing precision at the top of the range', () => {
    expect(computeFee(1_000_000_000_000n, 1000)).toEqual({
      feeBps: 1000,
      feeAmount: 100_000_000_000n,
      totalAmount: 1_100_000_000_000n,
    });
  });
});
