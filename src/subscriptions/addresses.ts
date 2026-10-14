import {
  findEventAuthorityPda,
  findPlanPda,
  findSubscriptionAuthorityPda,
  findSubscriptionDelegationPda,
} from '@solana/subscriptions';
import { address } from '@solana/kit';

export {
  SUBSCRIPTIONS_PROGRAM_ID,
  SUBSCRIPTIONS_ZERO_ADDRESS,
  UNKNOWN_INIT_ID,
} from './subscriptions-program.constants.js';

export interface DerivedAddress {
  address: string;
  bump: number;
}

/**
 * Unlike `accounts.ts`'s decoders — which only ever see bytes a cluster served and always
 * answer `null` — every function below can THROW (`SolanaError`, via kit's `address()` or the
 * SDK's PDA finders) for a malformed input: not a valid base58 address, a `planId` outside
 * `u64`, and similar. That is the right contract for values the caller controls; a caller
 * passing an ID it minted itself is a caller with a bug, not a hostile input needing a soft
 * "I could not read that".
 */

/**
 * A plan's identity is (owner, planId) and nothing else — not the recipient, not the price.
 * A plan owner that numbers its own plans fully determines every plan address, and two
 * callers deriving the same pair always agree.
 */
export async function derivePlanAddress(
  ownerAddress: string,
  planId: bigint,
): Promise<DerivedAddress> {
  const [pda, bump] = await findPlanPda({ owner: address(ownerAddress), planId });
  return { address: pda, bump };
}

/**
 * ONE authority per payer per mint — NOT per plan. The same account serves every subscription
 * that wallet holds in USDC, on every platform using this program. It carries an `initId`
 * that `subscribe` binds to, so a payer who closes and re-initialises it invalidates
 * subscriptions created against the old id.
 */
export async function deriveSubscriptionAuthorityAddress(
  payerWallet: string,
  mint: string,
): Promise<DerivedAddress> {
  const [pda, bump] = await findSubscriptionAuthorityPda({
    user: address(payerWallet),
    tokenMint: address(mint),
  });
  return { address: pda, bump };
}

/** One subscription per (plan, payer). The address is REUSED on re-subscribe. */
export async function deriveSubscriptionAddress(
  planAddress: string,
  payerWallet: string,
): Promise<DerivedAddress> {
  const [pda, bump] = await findSubscriptionDelegationPda({
    planPda: address(planAddress),
    subscriber: address(payerWallet),
  });
  return { address: pda, bump };
}

/** Required on `subscribe`, `transferSubscription` and `updatePlan`; the program self-CPIs
 *  through it to emit its events. */
export async function deriveEventAuthorityAddress(): Promise<string> {
  const [pda] = await findEventAuthorityPda();
  return pda;
}
