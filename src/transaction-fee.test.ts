import { transactionFeeLamports } from './transaction-fee.js';

describe('transactionFeeLamports', () => {
  it('charges 5 000 per signature plus the priority fee the compute budget asks for', () => {
    // A plain payment: one signature, 60 000 CU at 1 000 µlamports.
    expect(transactionFeeLamports({ signatures: 1, computeUnitLimit: 60_000, computeUnitPriceMicroLamports: 1_000n })).toBe(5_060n);
    // A subscribe: a second signer co-signs, 400 000 CU.
    expect(transactionFeeLamports({ signatures: 2, computeUnitLimit: 400_000, computeUnitPriceMicroLamports: 1_000n })).toBe(10_400n);
  });

  it('rounds a fractional priority fee UP, as the runtime does', () => {
    expect(transactionFeeLamports({ signatures: 1, computeUnitLimit: 1, computeUnitPriceMicroLamports: 1n })).toBe(5_001n);
    expect(transactionFeeLamports({ signatures: 1, computeUnitLimit: 0, computeUnitPriceMicroLamports: 1_000n })).toBe(5_000n);
  });
});
