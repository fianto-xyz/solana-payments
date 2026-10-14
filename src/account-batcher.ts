import type { AccountData, AccountsReader, RpcCallOptions } from './rpc.js';
import { MAX_ACCOUNTS_PER_CALL } from './solana.constants.js';

interface Waiter {
  resolve: (account: AccountData | null) => void;
  reject: (error: unknown) => void;
}

/**
 * Single-account reads that arrive within `windowMs` of each other go out as ONE `getAccounts`
 * call (up to MAX_ACCOUNTS_PER_CALL addresses; the same address once): fifty simultaneous
 * reads cost one RPC call, not fifty. A failed call fails every read in it. One batcher per runtime.
 */
export class AccountBatcher {
  private pending = new Map<string, Waiter[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly reader: AccountsReader,
    private readonly options: RpcCallOptions,
    private readonly windowMs = 20,
  ) {}

  read(address: string): Promise<AccountData | null> {
    return new Promise((resolve, reject) => {
      const waiters = this.pending.get(address);
      if (waiters) waiters.push({ resolve, reject });
      else this.pending.set(address, [{ resolve, reject }]);
      if (this.pending.size >= MAX_ACCOUNTS_PER_CALL) this.flush();
      else this.timer ??= setTimeout(() => this.flush(), this.windowMs);
    });
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.pending;
    this.pending = new Map();
    if (batch.size === 0) return;
    const addresses = [...batch.keys()];
    this.reader.getAccounts(addresses, this.options).then(
      (accounts) => addresses.forEach((address, index) => batch.get(address)!.forEach((w) => w.resolve(accounts[index] ?? null))),
      (error: unknown) => batch.forEach((waiters) => waiters.forEach((w) => w.reject(error))),
    );
  }
}
