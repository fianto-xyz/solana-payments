import { getTokenDecoder } from '@solana-program/token';
import { getBase64Encoder } from '@solana/kit';
import type { AccountData, TokenAccountInfo } from './rpc.js';

/**
 * A token account's fields from its raw account, or null when it is not one: missing, or owned
 * by any other program (Token-2022 included: not a classic token account). `getTokenAccount` and a batched
 * `getAccounts` read decode alike through this.
 */
export function tokenAccountFrom(account: AccountData | null, tokenProgram: string): TokenAccountInfo | null {
  if (!account || account.owner !== tokenProgram || !account.dataBase64) return null;
  const decoded = getTokenDecoder().decode(getBase64Encoder().encode(account.dataBase64));
  return {
    mint: decoded.mint,
    owner: decoded.owner,
    amount: decoded.amount,
    // AccountState: 0 Uninitialized, 1 Initialized, 2 Frozen.
    isFrozen: decoded.state === 2,
  };
}
