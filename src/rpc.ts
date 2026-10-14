/** One account, as the cluster holds it. `dataBase64` is empty for a zero-length account. */
export interface AccountData {
  owner: string;
  lamports: bigint;
  dataBase64: string;
}

export interface TokenAccountInfo {
  mint: string;
  owner: string;
  amount: bigint;
  isFrozen: boolean;
}

/** Passed through untouched to the reader; this library never reads it. */
export type RpcCallOptions = Readonly<Record<string, unknown>>;

/** The one read `AccountBatcher` needs. Wrap your RPC client in this shape. */
export interface AccountsReader {
  getAccounts(addresses: string[], options?: RpcCallOptions): Promise<(AccountData | null)[]>;
}

/** Thrown by a caller's rate limiter when the next RPC slot is further away than it will wait. */
export class SolanaRpcBusyError extends Error {
  constructor(waitMs: number, maxWaitMs: number) {
    super(`The Solana RPC is busy: the next slot is ${waitMs} ms away, over ${maxWaitMs} ms.`);
    this.name = 'SolanaRpcBusyError';
  }
}
