import {
  MAX_PLAN_DESTINATIONS as SDK_MAX_PLAN_DESTINATIONS,
  MAX_PLAN_PULLERS as SDK_MAX_PLAN_PULLERS,
  PLAN_SIZE as SDK_PLAN_SIZE,
  SUBSCRIPTION_SIZE as SDK_SUBSCRIPTION_SIZE,
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  UNKNOWN_INIT_ID as SDK_UNKNOWN_INIT_ID,
  ZERO_ADDRESS,
} from '@solana/subscriptions';

// Re-exported as plain strings, never as kit's branded `Address`: the rest of the
// library deals in strings and bigints.
export const SUBSCRIPTIONS_PROGRAM_ID: string = SUBSCRIPTIONS_PROGRAM_ADDRESS;
/** The address that fills an unused slot of a plan's fixed 4-wide destination/puller array. */
export const SUBSCRIPTIONS_ZERO_ADDRESS: string = ZERO_ADDRESS;

/**
 * Account sizes. `PLAN_ACCOUNT_BYTES` and `SUBSCRIPTION_ACCOUNT_BYTES` are the SDK's own
 * `PLAN_SIZE`/`SUBSCRIPTION_SIZE` re-exported under this library's naming — so a package
 * upgrade that changed either is a value that moves with it, not a literal that silently
 * diverges. `AUTHORITY_ACCOUNT_BYTES` is NOT exported by the SDK; 106 is hand-computed from
 * `SubscriptionAuthority`'s real field layout (discriminator 1 + user 32 + tokenMint 32 +
 * payer 32 + bump 1 + initId 8 = 106) and confirmed against the real encoder's output length.
 */
export const PLAN_ACCOUNT_BYTES: number = SDK_PLAN_SIZE;
export const SUBSCRIPTION_ACCOUNT_BYTES: number = SDK_SUBSCRIPTION_SIZE;
export const AUTHORITY_ACCOUNT_BYTES = 106;


/**
 * A plan's destination and puller arrays hold at most four entries each.
 * Re-exported from the SDK's own `MAX_PLAN_DESTINATIONS`/`MAX_PLAN_PULLERS` — kept as TWO
 * separate re-exports, not one shared constant, because the program declares them separately
 * and a future version could diverge them; today both happen to be 4.
 */
export const MAX_PLAN_DESTINATIONS: number = SDK_MAX_PLAN_DESTINATIONS;
export const MAX_PLAN_PULLERS: number = SDK_MAX_PLAN_PULLERS;

/**
 * What a brand-new `SubscriptionAuthority` is created with, before the program writes its
 * real init id. `subscribe` in the SAME transaction reads the real value back, so this is
 * what `subscribeData.expectedSubscriptionAuthorityInitId` must carry when the authority is
 * being created by the very transaction that subscribes.
 */
export const UNKNOWN_INIT_ID: bigint = SDK_UNKNOWN_INIT_ID;
