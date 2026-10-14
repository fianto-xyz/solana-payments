import { getBase64Encoder } from '@solana/kit';
import type { AccountData } from '../rpc.js';
import {
  getPlanDecoder,
  getSubscriptionAuthorityDecoder,
  getSubscriptionDelegationDecoder,
  PlanStatus,
} from '@solana/subscriptions';
import {
  AUTHORITY_ACCOUNT_BYTES,
  PLAN_ACCOUNT_BYTES,
  SUBSCRIPTION_ACCOUNT_BYTES,
  SUBSCRIPTIONS_PROGRAM_ID,
  SUBSCRIPTIONS_ZERO_ADDRESS,
} from './subscriptions-program.constants.js';

/** Account discriminators, as the program writes them into byte 0. */
const DISCRIMINATOR = { AUTHORITY: 0, PLAN: 1, SUBSCRIPTION: 4 } as const;

export interface OnchainPlanAccount {
  owner: string;
  status: 'ACTIVE' | 'SUNSET';
  planId: bigint;
  mint: string;
  /** The per-period cap: the most the plan may pull in one period. */
  amount: bigint;
  periodHours: number;
  /** The on-chain creation timestamp, which `subscribe` binds the payer's signature to. */
  createdAt: bigint;
  /** 0 = no end. */
  endTs: bigint;
  /** Only the filled slots; the zero-address padding is dropped. */
  destinations: string[];
  pullers: string[];
}

export interface OnchainSubscriptionAccount {
  subscriber: string;
  planAddress: string;
  rentPayer: string;
  initId: bigint;
  amount: bigint;
  periodHours: number;
  termsCreatedAt: bigint;
  amountPulledInPeriod: bigint;
  /** The anchor: set to the on-chain clock at subscribe and advanced by whole periods. */
  currentPeriodStartTs: bigint;
  /** 0 = not cancelled. Otherwise the end of the period the payer cancelled in. */
  expiresAtTs: bigint;
}

export interface OnchainAuthorityAccount {
  user: string;
  tokenMint: string;
  initId: bigint;
  bump: number;
}

/**
 * Bytes off a cluster are never trusted: a wrong account at a right address, a truncated
 * read, a program upgrade that moved a field. Every decoder here answers `null` instead of
 * throwing, so a caller can say "I could not read that" without turning it into a server error.
 */
function bytesOf(
  dataBase64: string,
  expectedLength: number,
  discriminator: number,
): Uint8Array | null {
  if (!dataBase64) return null;
  let bytes: Uint8Array;
  try {
    bytes = getBase64Encoder().encode(dataBase64) as Uint8Array;
  } catch {
    return null;
  }
  if (bytes.length !== expectedLength) return null;
  if (bytes[0] !== discriminator) return null;
  return bytes;
}

function filled(addresses: readonly string[]): string[] {
  return addresses.filter((entry) => entry !== SUBSCRIPTIONS_ZERO_ADDRESS);
}

export function decodePlanAccount(dataBase64: string): OnchainPlanAccount | null {
  const bytes = bytesOf(dataBase64, PLAN_ACCOUNT_BYTES, DISCRIMINATOR.PLAN);
  if (!bytes) return null;
  try {
    const plan = getPlanDecoder().decode(bytes);
    // The SDK types `status` as a plain `number`, not the `PlanStatus` enum, so nothing else
    // validates it: a status byte the program never wrote (only 0 and 1 are real) must not
    // decode into a plausible struct, or a plan that is neither Active nor Sunset would read
    // as "SUNSET" and silently stop renewals rather than surfacing as "I could not read that".
    if (plan.status !== PlanStatus.Active && plan.status !== PlanStatus.Sunset) return null;
    return {
      owner: plan.owner,
      status: plan.status === PlanStatus.Active ? 'ACTIVE' : 'SUNSET',
      planId: plan.data.planId,
      mint: plan.data.mint,
      amount: plan.data.terms.amount,
      periodHours: Number(plan.data.terms.periodHours),
      createdAt: plan.data.terms.createdAt,
      endTs: plan.data.endTs,
      destinations: filled(plan.data.destinations),
      pullers: filled(plan.data.pullers),
    };
  } catch {
    return null;
  }
}

export function decodeSubscriptionAccount(
  dataBase64: string,
): OnchainSubscriptionAccount | null {
  const bytes = bytesOf(dataBase64, SUBSCRIPTION_ACCOUNT_BYTES, DISCRIMINATOR.SUBSCRIPTION);
  if (!bytes) return null;
  try {
    const subscription = getSubscriptionDelegationDecoder().decode(bytes);
    return {
      subscriber: subscription.header.delegator,
      planAddress: subscription.header.delegatee,
      rentPayer: subscription.header.payer,
      initId: subscription.header.initId,
      amount: subscription.terms.amount,
      periodHours: Number(subscription.terms.periodHours),
      termsCreatedAt: subscription.terms.createdAt,
      amountPulledInPeriod: subscription.amountPulledInPeriod,
      currentPeriodStartTs: subscription.currentPeriodStartTs,
      expiresAtTs: subscription.expiresAtTs,
    };
  } catch {
    return null;
  }
}

export function decodeAuthorityAccount(dataBase64: string): OnchainAuthorityAccount | null {
  const bytes = bytesOf(dataBase64, AUTHORITY_ACCOUNT_BYTES, DISCRIMINATOR.AUTHORITY);
  if (!bytes) return null;
  try {
    const authority = getSubscriptionAuthorityDecoder().decode(bytes);
    return {
      user: authority.user,
      tokenMint: authority.tokenMint,
      initId: authority.initId,
      bump: authority.bump,
    };
  } catch {
    return null;
  }
}

/**
 * What an account at a program address IS, as far as the Subscriptions program is concerned.
 *
 * - `absent`: nothing there, OR an account the program does not own, OR one with zero-length
 *   data. Only the program can create an account it owns, so anything else at the address is
 *   NOT a subscription (or plan) — in particular, once a cancelled subscription's PDA is
 *   closed, ANYONE can send lamports to that address and leave an empty System-owned account
 *   there. That must read as "gone", never as "something that cannot be read".
 * - `unreadable`: program-owned bytes that fail to decode — a program upgrade, a layout this
 *   decoder does not know. A problem of the reader, never evidence about the payer.
 * - `present`: decoded.
 */
export type ProgramAccountRead<T> =
  | { state: 'absent' }
  | { state: 'unreadable' }
  | { state: 'present'; account: T };

function readOwned<T>(
  account: AccountData | null,
  decode: (dataBase64: string) => T | null,
): ProgramAccountRead<T> {
  if (!account || account.owner !== SUBSCRIPTIONS_PROGRAM_ID || !account.dataBase64) {
    return { state: 'absent' };
  }
  const decoded = decode(account.dataBase64);
  return decoded === null ? { state: 'unreadable' } : { state: 'present', account: decoded };
}

export function readSubscriptionAccount(
  account: AccountData | null,
): ProgramAccountRead<OnchainSubscriptionAccount> {
  return readOwned(account, decodeSubscriptionAccount);
}

export function readPlanAccount(account: AccountData | null): ProgramAccountRead<OnchainPlanAccount> {
  return readOwned(account, decodePlanAccount);
}

/** The payer's per-(wallet, mint) authority, read owner-aware — the same absent / unreadable /
 *  present contract as the subscription and plan readers. Callers re-authorising
 *  must tell "closed" (a new init would mint a new init_id and strand every existing
 *  subscription) from "there". */
export function readAuthorityAccount(
  account: AccountData | null,
): ProgramAccountRead<OnchainAuthorityAccount> {
  return readOwned(account, decodeAuthorityAccount);
}
