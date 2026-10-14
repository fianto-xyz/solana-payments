/**
 * Transaction-level errors a cluster reports for a transaction that is fine in itself but
 * could not be evaluated or scheduled RIGHT NOW — a blockhash one provider has not seen yet
 * (the blockhash and the simulation can come from different providers), a hot account, a full
 * block. They carry no program code, so without this list they would read as an
 * unrecognised program failure and misreport a transient failure as a program failure.
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
