import { LAMPORTS_PER_SIGNATURE } from './solana.constants.js';

/**
 * The network fee a transaction will cost its fee payer: the base fee per signature
 * plus the priority fee its compute budget asks for (`ceil(limit × price / 1e6)`, the runtime's
 * rounding). Pure; a wallet may still raise the priority fee, which callers cover with a margin.
 */
export function transactionFeeLamports(input: {
  signatures: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: bigint;
}): bigint {
  const microLamports = BigInt(input.computeUnitLimit) * input.computeUnitPriceMicroLamports;
  const priority = (microLamports + 999_999n) / 1_000_000n;
  return BigInt(input.signatures) * LAMPORTS_PER_SIGNATURE + priority;
}
