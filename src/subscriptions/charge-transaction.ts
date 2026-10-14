import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import {
  AccountRole,
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
} from '@solana/kit';
import { getTransferSubscriptionInstruction } from '@solana/subscriptions';
import type { TransactionSigner } from '../transaction-signer.js';
import { TOKEN_PROGRAM_ADDRESS } from '../solana.constants.js';
import { deriveEventAuthorityAddress } from './addresses.js';

export interface ChargeTransactionInput {
  puller: TransactionSigner;
  payerWallet: string;
  payerTokenAccount: string;
  planAddress: string;
  subscriptionAddress: string;
  authorityAddress: string;
  mint: string;
  recipientTokenAccount: string;
  /** Null exactly when feeAmount + networkFeeAmount is 0 — anything else is refused, never
   *  silently repaired. */
  feeRecipientTokenAccount: string | null;
  amount: bigint;
  feeAmount: bigint;
  /** The network fee the payer pays with every charge: pulled to the fee recipient in the SAME pull as
   *  the fee (fee + network fee), inside the plan's cap. */
  networkFeeAmount: bigint;
  /**
   * Required, and deliberately not nullable: a charge without a reference cannot be matched to
   * the payment it settles, so it must be impossible to build.
   */
  reference: string;
  blockhash: string;
  lastValidBlockHeight: bigint;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: bigint;
}

/**
 * A refusal to build: always a CALLER (or signer) bug, never the network, so a caller can
 * treat it as a bug in the caller or signer, not as a transient network failure.
 * Its messages are fixed, developer-authored strings, safe to log.
 */
export class ChargeBuildRefused extends Error {
  override readonly name = 'ChargeBuildRefused';
}

export interface BuiltCharge {
  base64: string;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: bigint;
}

/**
 * A charge's message, compiled and NOT signed: every signature slot is empty, which the wire
 * encoding writes as 64 zero bytes. This is what a caller can SIMULATE — bytes nobody can
 * broadcast — so a signed charge never leaves the process before the caller has recorded it.
 */
export interface CompiledCharge {
  /** The unsigned wire transaction, base64. */
  base64: string;
  messageBytes: Uint8Array;
  feePayer: string;
  blockhash: string;
  lastValidBlockHeight: bigint;
}

/**
 * A charge: one or two `transferSubscription` pulls, nothing else: the price to the recipient,
 * and the fee plus the network fee to the fee recipient. The PULLER is the fee payer — the
 * payer signed once, at subscribe, and never signs again — and it is the only signer, so this
 * transaction is complete when it comes back from `sign`.
 *
 * The `reference` rides as an extra read-only account on the FIRST pull, exactly as at
 * subscribe, so a charge is findable by address (getSignaturesForAddress) like every other
 * payment.
 *
 * Every refusal here is a CALLER bug, never a payer input, and each one exists because the
 * alternative is a transaction that disagrees with what the caller recorded for it — which can
 * only be discovered at finality, after the money has moved.
 *
 * `compileChargeTransaction` + `signChargeTransaction`, in one call.
 */
export async function buildChargeTransaction(input: ChargeTransactionInput): Promise<BuiltCharge> {
  return signChargeTransaction(await compileChargeTransaction(input), input.puller);
}

/**
 * The charge's message, compiled with the puller as fee payer and NOTHING signed. Only the
 * key's ADDRESS is read here; signing is `signChargeTransaction`, after any simulation.
 */
export async function compileChargeTransaction(
  input: Omit<ChargeTransactionInput, 'puller'> & { puller: { address: string } },
): Promise<CompiledCharge> {
  if (!input.reference) throw new ChargeBuildRefused('A charge must carry a reference');
  // A plain `feeAmount > 0n && feeRecipientTokenAccount` would silently DROP the fee pull when
  // the account was missing, while the caller still expects a fee to arrive. Refuse both
  // halves of the mismatch instead, as `buildSubscribeTransaction` does.
  const feeRecipientShare = input.feeAmount + input.networkFeeAmount;
  if ((feeRecipientShare > 0n) !== (input.feeRecipientTokenAccount !== null)) {
    throw new ChargeBuildRefused(
      'buildChargeTransaction: a fee recipient account is required exactly when fee + network fee is non-zero',
    );
  }
  const puller = createNoopSigner(address(input.puller.address));
  const eventAuthority = await deriveEventAuthorityAddress();
  const pull = (receiverAta: string, amount: bigint) =>
    getTransferSubscriptionInstruction({
      subscriptionPda: address(input.subscriptionAddress),
      planPda: address(input.planAddress),
      subscriptionAuthority: address(input.authorityAddress),
      delegatorAta: address(input.payerTokenAccount),
      receiverAta: address(receiverAta),
      caller: puller,
      tokenMint: address(input.mint),
      tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
      eventAuthority: address(eventAuthority),
      transferData: {
        amount,
        delegator: address(input.payerWallet),
        mint: address(input.mint),
      },
    });
  const recipientPull = pull(input.recipientTokenAccount, input.amount);
  // One array literal, never a `const` pushed to afterwards: `tsc` infers a `const` array's
  // element type from its initial literal and then refuses a differently-shaped instruction —
  // see `buildSubscribeTransaction`.
  const instructions = [
    getSetComputeUnitLimitInstruction({ units: input.computeUnitLimit }),
    getSetComputeUnitPriceInstruction({ microLamports: input.computeUnitPriceMicroLamports }),
    {
      ...recipientPull,
      accounts: [
        ...recipientPull.accounts,
        { address: address(input.reference), role: AccountRole.READONLY },
      ],
    },
    ...(input.feeRecipientTokenAccount !== null
      ? [pull(input.feeRecipientTokenAccount, feeRecipientShare)]
      : []),
  ];
  const message = pipe(
    createTransactionMessage({ version: 'legacy' as const }),
    (current) => setTransactionMessageFeePayer(address(input.puller.address), current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: input.blockhash as never, lastValidBlockHeight: input.lastValidBlockHeight },
        current,
      ),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  const compiled = compileTransaction(message);
  return {
    base64: getBase64EncodedWireTransaction(compiled),
    messageBytes: new Uint8Array(compiled.messageBytes),
    feePayer: input.puller.address,
    blockhash: input.blockhash,
    lastValidBlockHeight: input.lastValidBlockHeight,
  };
}

/**
 * Signs a compiled charge with the puller. Ed25519 is deterministic, so the signature — the
 * transaction's identity — is what it would have been had the message been signed first.
 */
export async function signChargeTransaction(
  compiled: CompiledCharge,
  puller: TransactionSigner,
): Promise<BuiltCharge> {
  if (puller.address !== compiled.feePayer) {
    throw new ChargeBuildRefused('buildChargeTransaction: the signer is not the fee payer');
  }
  const base64 = await puller.sign(compiled.base64);
  const signed = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  // The caller records THESE bytes and THIS signature. A signer that handed back a different
  // message — re-serialised, or worse — would put a transaction on chain that nothing the
  // caller recorded describes, so compare the message bytes exactly.
  if (!sameBytes(signed.messageBytes, compiled.messageBytes)) {
    throw new ChargeBuildRefused('buildChargeTransaction: the signer changed the message');
  }
  return {
    base64,
    signature: getSignatureFromTransaction(signed),
    blockhash: compiled.blockhash,
    lastValidBlockHeight: compiled.lastValidBlockHeight,
  };
}

function sameBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
