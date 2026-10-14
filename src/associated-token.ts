import { findAssociatedTokenPda } from '@solana-program/token';
import { address } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from './solana.constants.js';

/**
 * The classic-Token associated token account of `owner` for `mint`. Everyone's USDC lives
 * at this deterministic address, so the chain never has to be asked which account to pay.
 * Rejects anything that is not base58 of 32 bytes, so a malformed wallet fails here rather
 * than inside a transaction.
 */
export async function deriveAssociatedTokenAddress(
  owner: string,
  mint: string,
): Promise<string> {
  const [ata] = await findAssociatedTokenPda({
    owner: address(owner),
    tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
    mint: address(mint),
  });
  return ata;
}

/**
 * How many extra bump seeds the search for `owner`'s associated token account tries before it
 * finds one off the curve (255 - bump): 0 for most wallets, k for one in 2^k. The Subscriptions
 * program re-derives the PAYER's token account in every pull, and each extra try costs it
 * about 1,500 compute units (measured), so a caller can size a pull's compute budget per payer
 * from this.
 */
export async function associatedTokenSearchSteps(owner: string, mint: string): Promise<number> {
  const [, bump] = await findAssociatedTokenPda({
    owner: address(owner),
    tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
    mint: address(mint),
  });
  return 255 - bump;
}
