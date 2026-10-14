import { getTokenErrorMessage } from '@solana-program/token';
import {
  getSubscriptionsErrorMessage,
  SUBSCRIPTIONS_ERROR__ALREADY_SUBSCRIBED,
  SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT,
  SUBSCRIPTIONS_ERROR__DELEGATION_EXPIRED,
  SUBSCRIPTIONS_ERROR__DELEGATION_NOT_STARTED,
  SUBSCRIPTIONS_ERROR__INVALID_DELEGATE_PDA,
  SUBSCRIPTIONS_ERROR__NOT_PLAN_OWNER,
  SUBSCRIPTIONS_ERROR__NOT_SIGNER,
  SUBSCRIPTIONS_ERROR__PLAN_ALREADY_EXISTS,
  SUBSCRIPTIONS_ERROR__PLAN_EXPIRED,
  SUBSCRIPTIONS_ERROR__PLAN_SUNSET,
  SUBSCRIPTIONS_ERROR__PLAN_TERMS_MISMATCH,
  SUBSCRIPTIONS_ERROR__STALE_PLAN_APPROVAL,
  SUBSCRIPTIONS_ERROR__STALE_SUBSCRIPTION_AUTHORITY,
  SUBSCRIPTIONS_ERROR__SUBSCRIPTION_CANCELLED,
  SUBSCRIPTIONS_ERROR__UNAUTHORIZED,
  SUBSCRIPTIONS_ERROR__UNAUTHORIZED_DESTINATION,
} from '@solana/subscriptions';

/**
 * The codes this library reasons about, by name. Pinned here (and asserted in the tests)
 * so a package upgrade that renumbered one is a red test rather than a silent
 * misclassification of somebody's renewal.
 */
export const SUBSCRIPTION_PROGRAM_ERRORS = {
  NOT_SIGNER: SUBSCRIPTIONS_ERROR__NOT_SIGNER,
  INVALID_DELEGATE_PDA: SUBSCRIPTIONS_ERROR__INVALID_DELEGATE_PDA,
  UNAUTHORIZED: SUBSCRIPTIONS_ERROR__UNAUTHORIZED,
  STALE_SUBSCRIPTION_AUTHORITY: SUBSCRIPTIONS_ERROR__STALE_SUBSCRIPTION_AUTHORITY,
  AMOUNT_EXCEEDS_PERIOD_LIMIT: SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT,
  DELEGATION_NOT_STARTED: SUBSCRIPTIONS_ERROR__DELEGATION_NOT_STARTED,
  DELEGATION_EXPIRED: SUBSCRIPTIONS_ERROR__DELEGATION_EXPIRED,
  PLAN_SUNSET: SUBSCRIPTIONS_ERROR__PLAN_SUNSET,
  PLAN_EXPIRED: SUBSCRIPTIONS_ERROR__PLAN_EXPIRED,
  NOT_PLAN_OWNER: SUBSCRIPTIONS_ERROR__NOT_PLAN_OWNER,
  UNAUTHORIZED_DESTINATION: SUBSCRIPTIONS_ERROR__UNAUTHORIZED_DESTINATION,
  SUBSCRIPTION_CANCELLED: SUBSCRIPTIONS_ERROR__SUBSCRIPTION_CANCELLED,
  ALREADY_SUBSCRIBED: SUBSCRIPTIONS_ERROR__ALREADY_SUBSCRIBED,
  PLAN_ALREADY_EXISTS: SUBSCRIPTIONS_ERROR__PLAN_ALREADY_EXISTS,
  PLAN_TERMS_MISMATCH: SUBSCRIPTIONS_ERROR__PLAN_TERMS_MISMATCH,
  STALE_PLAN_APPROVAL: SUBSCRIPTIONS_ERROR__STALE_PLAN_APPROVAL,
} as const satisfies Readonly<Record<string, number>>;

/**
 * A landed or simulated transaction reports a program failure as
 * `{ InstructionError: [<index>, { Custom: <code> }] }`. Anything else — a string variant, a
 * transaction-level error, a shape a future runtime invents — is `null`, and callers treat
 * `null` as "I do not know why this failed", never as any particular reason.
 *
 * The INSTRUCTION INDEX matters: in a subscribe-and-charge transaction, a failure at the
 * `subscribe` instruction and a failure at the recipient pull mean completely different things.
 */
export function programErrorCodeOf(
  err: unknown,
): { instructionIndex: number; code: number } | null {
  if (typeof err !== 'object' || err === null) return null;
  const tuple = (err as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(tuple) || tuple.length < 2) return null;
  const [rawIndex, detail] = tuple as [unknown, unknown];
  const index = wholeNumberAtMost(rawIndex, MAX_INSTRUCTION_INDEX);
  if (index === null) return null;
  if (typeof detail !== 'object' || detail === null) return null;
  const code = wholeNumberAtMost((detail as { Custom?: unknown }).Custom, MAX_CUSTOM_CODE);
  if (code === null) return null;
  return { instructionIndex: index, code };
}

/** The runtime's own widths: an instruction index is a u8, a `Custom` code a u32. */
const MAX_INSTRUCTION_INDEX = 0xff;
const MAX_CUSTOM_CODE = 0xffff_ffff;

/**
 * A REAL cluster's error arrives through `@solana/kit`, which parses every JSON number in it
 * as a BIGINT (`{ InstructionError: [2n, { Custom: 400n }] }`, observed on a validator running
 * the mainnet program); hand-built errors use plain numbers. Both are the
 * same fact, so both are read — and anything negative, fractional or wider than the runtime's
 * own field is still `null`, never a guessed reason.
 */
function wholeNumberAtMost(value: unknown, max: number): number | null {
  if (typeof value === 'bigint') {
    return value >= 0n && value <= BigInt(max) ? Number(value) : null;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max) {
    return value;
  }
  return null;
}

/** The subscriptions program's own codes start here; below it is a CPI's code. */
const SUBSCRIPTIONS_PROGRAM_FIRST_CODE = 100;

/**
 * Text for logs and diagnostics, not for an end user. A
 * code below the program's own range is the SPL Token program's, returned through the pull's
 * CPI (a revoked approval would otherwise read "Unknown subscriptions program error 4", which is
 * the token program's OwnerMismatch).
 */
export function programErrorMessage(code: number): string {
  if (code < SUBSCRIPTIONS_PROGRAM_FIRST_CODE) {
    const token = messageOrUndefined(() => getTokenErrorMessage(code as never));
    return token ? `SPL Token error ${code}: ${token}` : `Unknown program error ${code}`;
  }
  const message = messageOrUndefined(() => getSubscriptionsErrorMessage(code as never));
  return message ?? `Unknown subscriptions program error ${code}`;
}

function messageOrUndefined(read: () => string | undefined): string | undefined {
  try {
    const message = read();
    return message && message.length > 0 ? message : undefined;
  } catch {
    return undefined;
  }
}
