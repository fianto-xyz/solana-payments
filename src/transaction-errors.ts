/**
 * Transaction-level errors a cluster reports for a transaction that is fine in itself but
 * could not be evaluated or scheduled RIGHT NOW — a blockhash the node has not seen yet
 * (a load-balanced endpoint can serve them from different nodes), a hot account, a full
 * block. They carry no program code, so without this list they would read as an
 * unrecognised program failure and a transient failure would be reported as a permanent one.
 *
 * The runtime reports these unit variants as plain strings (`"BlockhashNotFound"`), exactly
 * as `@solana/kit` passes them through from the RPC's JSON.
 */
const TRANSIENT_TRANSACTION_ERRORS: ReadonlySet<string> = new Set([
  'BlockhashNotFound',
  'AccountInUse',
  'ClusterMaintenance',
  'WouldExceedMaxBlockCostLimit',
  'WouldExceedMaxAccountCostLimit',
  'WouldExceedMaxVoteCostLimit',
  'WouldExceedAccountDataBlockLimit',
  'WouldExceedAccountDataTotalLimit',
]);

/** True for a transaction error that says "try again later", never "this is wrong". */
export function isTransientTransactionError(err: unknown): boolean {
  return typeof err === 'string' && TRANSIENT_TRANSACTION_ERRORS.has(err);
}
