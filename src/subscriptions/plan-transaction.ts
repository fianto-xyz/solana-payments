import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from '@solana/kit';
import {
  getCreatePlanInstruction,
  getUpdatePlanInstruction,
  PlanStatus,
} from '@solana/subscriptions';
import { TOKEN_PROGRAM_ADDRESS } from '../solana.constants.js';
import type { TransactionSigner } from '../transaction-signer.js';
import type { OnchainPlanAccount } from './accounts.js';
import { deriveEventAuthorityAddress, derivePlanAddress } from './addresses.js';
import {
  MAX_PLAN_DESTINATIONS,
  MAX_PLAN_PULLERS,
  SUBSCRIPTIONS_ZERO_ADDRESS,
} from './subscriptions-program.constants.js';

export interface BuiltPlanTransaction {
  /** base64 of a wire transaction the owner key has already signed. */
  base64: string;
  signature: string;
  planAddress: string;
}

export interface CreatePlanInput {
  owner: TransactionSigner;
  planId: bigint;
  mint: string;
  /** The per-period cap. The program enforces it; the caller chooses how a charge splits it. */
  capAmount: bigint;
  periodHours: number;
  /** WALLETS, not token accounts: the program checks the receiver ATA's owner. */
  destinations: string[];
  pullers: string[];
  blockhash: string;
  lastValidBlockHeight: bigint;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: bigint;
}

/** The fixed 4-wide arrays the program stores, padded with the zero address. */
function padded(addresses: string[], width: number, what: string): Address[] {
  if (addresses.length === 0) throw new Error(`A plan needs at least one ${what}`);
  if (addresses.length > width) throw new Error(`A plan may have at most ${width} ${what}s`);
  return [
    ...addresses.map((entry) => address(entry)),
    ...Array.from({ length: width - addresses.length }, () =>
      address(SUBSCRIPTIONS_ZERO_ADDRESS),
    ),
  ];
}

/**
 * The plan itself: the plan owner's on-chain account, paid for and signed for by the plan
 * owner. `endTs: 0` means the plan never expires — a subscription ends because the payer
 * cancels or stops paying, never because the plan ran out.
 *
 * `metadataUri` is deliberately empty: it is a public, on-chain string, readable by anyone,
 * so nothing about the recipient is written into it.
 */
export async function buildCreatePlanTransaction(
  input: CreatePlanInput,
): Promise<BuiltPlanTransaction> {
  // MAX_PLAN_DESTINATIONS and MAX_PLAN_PULLERS are two SEPARATE program-declared limits (both
  // currently 4) — keep each `padded()` call bound to its OWN constant even though a swap is
  // a no-op today, so a future program version that diverges them cannot regress silently here.
  const destinations = padded(input.destinations, MAX_PLAN_DESTINATIONS, 'destination');
  const pullers = padded(input.pullers, MAX_PLAN_PULLERS, 'puller');
  const { address: planAddress } = await derivePlanAddress(input.owner.address, input.planId);
  const owner = createNoopSigner(address(input.owner.address));

  const instruction = getCreatePlanInstruction({
    merchant: owner,
    planPda: address(planAddress),
    tokenMint: address(input.mint),
    tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
    planData: {
      planId: input.planId,
      mint: address(input.mint),
      terms: {
        amount: input.capAmount,
        periodHours: BigInt(input.periodHours),
        // ASSUMED, not run against a validator: the PROGRAM sets the real created_at from its
        // own clock and this field is ignored on input. Inert either way — planMatches never
        // compares createdAt, and any code that needs the real value (e.g. subscribe's
        // expectedCreatedAt) must read it back on-chain via decodePlanAccount regardless of
        // what this instruction sent.
        createdAt: 0n,
      },
      endTs: 0n,
      destinations,
      pullers,
      metadataUri: '',
    },
  });

  return finish(input.owner, planAddress, instruction, input);
}

export interface UpdatePlanPullersInput {
  owner: TransactionSigner;
  planAddress: string;
  /** The plan as it is ON CHAIN right now. The instruction is a compare-and-set on it: a
   *  stale read is refused by the program as StalePlanApproval (522), never applied. */
  current: OnchainPlanAccount;
  pullers: string[];
  blockhash: string;
  lastValidBlockHeight: bigint;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: bigint;
}

/**
 * Replaces the puller list on an ACTIVE plan. VERIFIED against the program source
 * (`update_plan.rs:150-187`): the Active branch writes `pullers` outright, gated on the
 * `expected_*` fields matching the live plan. A SUNSET plan may only have pullers REMOVED,
 * which is a different operation with different safety rules, so this builder refuses one
 * rather than silently doing something else.
 */
export async function buildUpdatePlanPullersTransaction(
  input: UpdatePlanPullersInput,
): Promise<BuiltPlanTransaction> {
  if (input.current.status !== 'ACTIVE') {
    throw new Error('A SUNSET plan may only have pullers removed, not replaced');
  }
  const pullers = padded(input.pullers, MAX_PLAN_PULLERS, 'puller');
  const expectedPullers = padded(input.current.pullers, MAX_PLAN_PULLERS, 'puller');
  const owner = createNoopSigner(address(input.owner.address));
  const eventAuthority = await deriveEventAuthorityAddress();

  const instruction = getUpdatePlanInstruction({
    owner,
    planPda: address(input.planAddress),
    eventAuthority: address(eventAuthority),
    updatePlanData: {
      status: PlanStatus.Active,
      endTs: input.current.endTs,
      pullers,
      metadataUri: '',
      expectedCreatedAt: input.current.createdAt,
      expectedEndTs: input.current.endTs,
      expectedPullers,
      expectedMetadataUri: '',
    },
  });

  return finish(input.owner, input.planAddress, instruction, input);
}

export interface SunsetPlanInput {
  owner: TransactionSigner;
  planAddress: string;
  /** The plan as it is ON CHAIN right now: the update is a compare-and-set on it. */
  current: OnchainPlanAccount;
  /** Unix seconds. The program requires its own clock + one period <= endTs
   *  (`validate_plan_end_ts`), so the caller adds a margin for the time to land. */
  endTs: bigint;
  blockhash: string;
  lastValidBlockHeight: bigint;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: bigint;
}

/**
 * Ends a plan for good. VERIFIED against the program source: `update_plan.rs`'s Active branch
 * sets status, end_ts and pullers in one compare-and-set; Sunset requires a non-zero end_ts at
 * least one period out (`state/common.rs` `validate_plan_end_ts`); `subscribe` refuses a Sunset
 * plan; and `state/plan.rs` `can_pull` admits only the owner or a listed puller. With every
 * puller removed, only the plan owner's key can still pull, and only until end_ts (`can_pull`
 * admits it); after end_ts nobody can. A caller that never pulls with the owner key stops all
 * charges here. A Sunset plan is immutable but for removing pullers, so this refuses one.
 */
export async function buildSunsetPlanTransaction(
  input: SunsetPlanInput,
): Promise<BuiltPlanTransaction> {
  if (input.current.status !== 'ACTIVE') throw new Error('The plan is already sunset');
  if (input.current.endTs !== 0n && input.endTs > input.current.endTs) {
    throw new Error('A finite plan end can only be brought forward');
  }
  const zero = address(SUBSCRIPTIONS_ZERO_ADDRESS);
  const owner = createNoopSigner(address(input.owner.address));
  const eventAuthority = await deriveEventAuthorityAddress();
  const instruction = getUpdatePlanInstruction({
    owner,
    planPda: address(input.planAddress),
    eventAuthority: address(eventAuthority),
    updatePlanData: {
      status: PlanStatus.Sunset,
      endTs: input.endTs,
      pullers: Array.from({ length: MAX_PLAN_PULLERS }, () => zero),
      metadataUri: '',
      expectedCreatedAt: input.current.createdAt,
      expectedEndTs: input.current.endTs,
      expectedPullers: [
        ...input.current.pullers.map((puller) => address(puller)),
        ...Array.from({ length: MAX_PLAN_PULLERS - input.current.pullers.length }, () => zero),
      ],
      expectedMetadataUri: '',
    },
  });
  return finish(input.owner, input.planAddress, instruction, input);
}

async function finish(
  owner: TransactionSigner,
  planAddress: string,
  instruction: Parameters<typeof appendTransactionMessageInstructions>[0][number],
  lifetime: {
    blockhash: string;
    lastValidBlockHeight: bigint;
    computeUnitLimit: number;
    computeUnitPriceMicroLamports: bigint;
  },
): Promise<BuiltPlanTransaction> {
  const message = pipe(
    createTransactionMessage({ version: 'legacy' as const }),
    (current) => setTransactionMessageFeePayer(address(owner.address), current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: lifetime.blockhash as never,
          lastValidBlockHeight: lifetime.lastValidBlockHeight,
        },
        current,
      ),
    (current) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: lifetime.computeUnitLimit }),
          getSetComputeUnitPriceInstruction({
            microLamports: lifetime.computeUnitPriceMicroLamports,
          }),
          instruction,
        ],
        current,
      ),
  );
  const unsigned = getBase64EncodedWireTransaction(compileTransaction(message));
  const base64 = await owner.sign(unsigned);
  const signature = getSignatureFromTransaction(
    getTransactionDecoder().decode(getBase64Encoder().encode(base64)),
  );
  return { base64, signature, planAddress };
}

/**
 * Whether a plan read back off the chain is the plan that was asked for. Use it after a
 * create-plan transaction finalizes: a finalized transaction with no error is not proof the
 * account says what was meant, and every subscription ever signed against this plan binds to
 * its terms.
 *
 * Destinations and pullers are compared as SETS: the program stores them in fixed slots and
 * nothing here depends on the order.
 */
export function planMatches(
  plan: OnchainPlanAccount,
  expected: {
    mint: string;
    capAmount: bigint;
    periodHours: number;
    destinations: string[];
    pullers: string[];
  },
): boolean {
  const sameSet = (left: string[], right: string[]): boolean =>
    left.length === right.length && [...left].sort().join() === [...right].sort().join();
  return (
    plan.status === 'ACTIVE' &&
    plan.endTs === 0n &&
    plan.mint === expected.mint &&
    plan.amount === expected.capAmount &&
    plan.periodHours === expected.periodHours &&
    sameSet(plan.destinations, expected.destinations) &&
    sameSet(plan.pullers, expected.pullers)
  );
}
