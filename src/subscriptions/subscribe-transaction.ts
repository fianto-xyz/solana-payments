import {
  ComputeBudgetInstruction,
  getRequestHeapFrameInstructionDataDecoder,
  getRequestUnitsInstructionDataDecoder,
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitLimitInstructionDataDecoder,
  getSetComputeUnitPriceInstruction,
  getSetComputeUnitPriceInstructionDataDecoder,
  getSetLoadedAccountsDataSizeLimitInstructionDataDecoder,
  identifyComputeBudgetInstruction,
} from '@solana-program/compute-budget';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  decompileTransactionMessage,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  getInitSubscriptionAuthorityInstruction,
  getInitSubscriptionAuthorityInstructionDataDecoder,
  getSubscribeInstruction,
  getSubscribeInstructionDataDecoder,
  getTransferSubscriptionInstruction,
  getTransferSubscriptionInstructionDataDecoder,
  identifySubscriptionsInstruction,
  parseSubscriptionsInstruction,
  SubscriptionsInstruction,
} from '@solana/subscriptions';
import { bytesEqual } from '../bytes-equal.js';
import { verifyWalletSignature } from '../wallet-signature.js';
import { MAX_SIGNED_TRANSACTION_BASE64 } from '../payment-transaction.js';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from '../solana.constants.js';
import { deriveEventAuthorityAddress } from './addresses.js';
import { SUBSCRIPTIONS_PROGRAM_ID } from './subscriptions-program.constants.js';

/**
 * What the payer is being asked to sign, and therefore exactly what must come back. Every
 * field is compared; nothing is re-derived at validation time. Store it when the transaction
 * is BUILT and read it back when the signed transaction is SUBMITTED.
 */
export interface SubscribeExpectation {
  payerWallet: string;
  payerTokenAccount: string;
  /** The plan owner — the instruction's `merchant` account. */
  planOwner: string;
  planAddress: string;
  planBump: number;
  planId: bigint;
  subscriptionAddress: string;
  authorityAddress: string;
  authorityInitId: bigint;
  /** False → the transaction must carry exactly one initSubscriptionAuthority; true → none. */
  authorityExists: boolean;
  mint: string;
  decimals: number;
  /** The plan's per-period cap: the LIST price + fee + network fee, which the payer approves. The first charge takes
   *  at most this — less when the first charge is discounted. */
  capAmount: bigint;
  periodHours: number;
  /** The plan account's on-chain `terms.created_at`. */
  termsCreatedAt: bigint;
  /** The price, pulled to the recipient. */
  amount: bigint;
  /** The fee, pulled to the fee recipient with the network fee. */
  feeAmount: bigint;
  /** The plan's network fee: pulled to the fee recipient with the fee, in one pull. Fee +
   *  network fee = 0 omits that pull entirely. */
  networkFeeAmount: bigint;
  recipientTokenAccount: string;
  feeRecipientTokenAccount: string | null;
  reference: string;
  blockhash: string;
  /** The puller that must be the `caller` of both pulls. */
  puller: string;
}

export interface SubscribeTransactionInput extends SubscribeExpectation {
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: bigint;
  lastValidBlockHeight: bigint;
}

export type SubscribeValidationFailure =
  | 'too_large'
  | 'undecodable'
  | 'not_legacy'
  | 'wrong_blockhash'
  | 'wrong_fee_payer'
  | 'unexpected_program'
  | 'unexpected_instruction'
  | 'missing_subscribe'
  | 'missing_authority_init'
  | 'unexpected_authority_init'
  | 'wrong_authority'
  | 'wrong_plan'
  | 'wrong_terms'
  | 'wrong_subscription'
  | 'wrong_transfer_count'
  | 'wrong_destination'
  | 'wrong_amount'
  | 'wrong_delegator'
  | 'wrong_caller'
  | 'missing_reference'
  /** The static account list carries something no accepted instruction references — the only
   *  other way (besides a role flag) a payer can ride an extra address along in a transaction
   *  a co-signer will sign. See the doc comment on the check itself. */
  | 'wrong_accounts'
  /** The message's signer set is not exactly {payer, puller} with the puller read-only — see
   *  the doc comment on the check itself for why a ROLE, not just an address, can cost the
   *  co-signer real money. */
  | 'wrong_signers'
  | 'missing_signature'
  | 'bad_signature'
  /** The compiled message, re-encoded with the SDK's own encoder, does not reproduce
   *  `messageBytes` byte for byte — bytes the payer signed but that no compiled field
   *  accounts for (the same gap `validateSignedPayerAction` closes). */
  | 'trailing_bytes';

export type SubscribeValidation =
  | { ok: true; signature: string }
  | { ok: false; reason: SubscribeValidationFailure };

/** The named accounts `transferSubscription` declares; anything past them is an extra. */
const TRANSFER_NAMED_ACCOUNTS = 10;
/** The named accounts `subscribe` declares. A ninth is the optional RENT PAYER — never built here. */
const SUBSCRIBE_NAMED_ACCOUNTS = 8;
/** The named accounts `initSubscriptionAuthority` declares. A seventh is the optional sponsor
 *  that pays the new account's rent — never built here, same posture as `subscribe`'s ninth. */
const INIT_AUTHORITY_NAMED_ACCOUNTS = 6;
/** Solana's System Program. Fixed, well-known, never derived — every instruction below that
 *  names it is asserted against this literal, exactly like `TOKEN_PROGRAM_ADDRESS`. */
const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111';

/**
 * The transaction the payer signs: compute budget, `initSubscriptionAuthority` when the
 * wallet has none, `subscribe` bound to the plan's exact terms, and one or two
 * `transferSubscription` pulls — the price to the recipient and the fee to the fee recipient.
 *
 * The REFERENCE rides as an extra read-only account on the FIRST pull. It may NOT be appended
 * to `subscribe`: that instruction's ninth account is the optional rent payer and must be a
 * signer, so a read-only account there fails on chain with NotSigner (100). A pull forwards
 * its extra accounts to the token CPI only for a mint with a Token-2022 transfer hook, and
 * USDC has none — so the reference is ignored by the program while still appearing in the
 * transaction's `accountKeys`, which is what lets the payment be found by its reference.
 *
 * Fee payer is the PAYER. The puller is a required signer of both pulls, but its signature is
 * added only after validation, immediately before broadcast.
 */
export async function buildSubscribeTransaction(
  input: SubscribeTransactionInput,
): Promise<{ base64: string; lastValidBlockHeight: bigint }> {
  // A caller bug, not a payer input: fail loudly here rather than build a transaction the
  // validator below would refuse (`wrong_transfer_count`) after the payer already signed it.
  if (feeRecipientShareOf(input) > 0n && !input.feeRecipientTokenAccount) {
    throw new Error('buildSubscribeTransaction: a non-zero fee or network fee needs a feeRecipientTokenAccount');
  }
  // The payer approves the plan's cap; the first charge is the caller's (a discount takes it
  // below the cap, never above). A caller bug otherwise: a charge the program would refuse, or
  // one the payer never agreed to.
  if (!firstChargeWithinCap(input)) {
    throw new Error('buildSubscribeTransaction: the first charge must be positive and within the cap');
  }

  const payer = createNoopSigner(address(input.payerWallet));
  const puller = createNoopSigner(address(input.puller));
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
  const recipientPullWithReference = {
    ...recipientPull,
    accounts: [
      ...recipientPull.accounts,
      { address: address(input.reference), role: AccountRole.READONLY },
    ],
  };

  // A single array literal, not a mutated `const` pushed to afterwards: `tsc` infers a
  // `const` array's element type from its INITIAL literal, so pushing a
  // differently-shaped instruction later (a different program, a modified `accounts` list)
  // is rejected even though every element is a valid `Instruction`. Building the whole list —
  // conditional elements included, via spread of a possibly-empty array — as one literal lets
  // tsc infer the union across every element at once, exactly like `plan-transaction.ts`'s
  // inline `appendTransactionMessageInstructions` call.
  //
  // ORDER IS PART OF THE CONTRACT: compute budget, then the optional authority init, then
  // subscribe, then the recipient pull, then the fee recipient pull.
  // `validateSignedSubscribe` refuses anything else, so this order is not just convention.
  const instructions = [
    getSetComputeUnitLimitInstruction({ units: input.computeUnitLimit }),
    getSetComputeUnitPriceInstruction({ microLamports: input.computeUnitPriceMicroLamports }),
    ...(input.authorityExists
      ? []
      : [
          getInitSubscriptionAuthorityInstruction({
            owner: payer,
            subscriptionAuthority: address(input.authorityAddress),
            tokenMint: address(input.mint),
            userAta: address(input.payerTokenAccount),
            tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
          }),
        ]),
    getSubscribeInstruction({
      subscriber: payer,
      merchant: address(input.planOwner),
      planPda: address(input.planAddress),
      subscriptionPda: address(input.subscriptionAddress),
      subscriptionAuthorityPda: address(input.authorityAddress),
      eventAuthority: address(eventAuthority),
      subscribeData: {
        planId: input.planId,
        planBump: input.planBump,
        expectedMint: address(input.mint),
        expectedAmount: input.capAmount,
        expectedPeriodHours: BigInt(input.periodHours),
        expectedCreatedAt: input.termsCreatedAt,
        expectedSubscriptionAuthorityInitId: input.authorityInitId,
      },
    }),
    recipientPullWithReference,
    ...(feeRecipientShareOf(input) > 0n && input.feeRecipientTokenAccount
      ? [pull(input.feeRecipientTokenAccount, feeRecipientShareOf(input))]
      : []),
  ];

  const message = pipe(
    createTransactionMessage({ version: 'legacy' as const }),
    (current) => setTransactionMessageFeePayer(address(input.payerWallet), current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: input.blockhash as never, lastValidBlockHeight: input.lastValidBlockHeight },
        current,
      ),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  return {
    base64: getBase64EncodedWireTransaction(compileTransaction(message)),
    lastValidBlockHeight: input.lastValidBlockHeight,
  };
}

/**
 * STRUCTURAL validation, never a byte comparison: a wallet may re-serialise what it signed,
 * so this checks the MEANING. But "structural rather than byte-for-byte" is only meant to
 * tolerate a wallet's own priority fee — not arbitrary shape. Every
 * Subscriptions-program instruction is decoded and re-parsed with the SDK's own parser and
 * asserted field by field against `expectation` — including every one of `subscribeData`'s
 * seven fields — AND the message as a whole is bound: fixed instruction order, exact data
 * length on every instruction, the static account list is exactly the union of what the
 * accepted instructions reference, and the signer set is exactly {payer, puller} with the
 * puller read-only. The one deliberate allowance is any number of ComputeBudget
 * instructions carrying zero accounts — a payer's wallet may legitimately add a priority fee,
 * and the payer alone pays for it.
 *
 * The bytes are entirely payer-controlled and `expectation` is read back out of the caller's
 * storage; neither is trusted to be well-formed. Everything past the size check runs inside
 * one try/catch, so ANY decode or interpretation failure is a refusal and never an uncaught
 * exception.
 */
export async function validateSignedSubscribe(
  base64: string,
  expectation: SubscribeExpectation,
): Promise<SubscribeValidation> {
  // Defence in depth: an expectation whose charge exceeds the cap the payer approves is
  // never accepted, whatever the bytes say. Before any decoding.
  if (!firstChargeWithinCap(expectation)) return { ok: false, reason: 'wrong_amount' };
  if (base64.length > MAX_SIGNED_TRANSACTION_BASE64) return { ok: false, reason: 'too_large' };
  try {
    return await checkSignedSubscribe(base64, expectation);
  } catch {
    return { ok: false, reason: 'undecodable' };
  }
}

/** The writable non-signer slice of a legacy message's static accounts (signers first, then
 *  writable non-signers, then read-only non-signers). */
function writableNonSigners(
  statics: readonly string[],
  header: { numSignerAccounts: number; numReadonlyNonSignerAccounts: number },
): string[] {
  return statics.slice(header.numSignerAccounts, statics.length - header.numReadonlyNonSignerAccounts);
}

/** The writable non-signers of the transaction THIS MODULE builds for `expectation` — the roles the SDK's
 *  instruction builders assign. ComputeBudget adds only a read-only program, so the compute
 *  numbers here do not matter. */
async function expectedWritableNonSigners(expectation: SubscribeExpectation): Promise<Set<string>> {
  const built = await buildSubscribeTransaction({
    ...expectation,
    computeUnitLimit: 1,
    computeUnitPriceMicroLamports: 0n,
    lastValidBlockHeight: 0n,
  });
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(built.base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  return new Set(writableNonSigners(compiled.staticAccounts as readonly string[], compiled.header));
}

type SubscribeMessageInstruction = ReturnType<typeof decompileTransactionMessage>['instructions'][number];

/** Every ComputeBudget instruction kind the runtime recognises, and the EXACT byte length its
 *  own fixed-size decoder expects — read from the SDK's own codecs, never hand-computed, so an
 *  SDK upgrade that changed one could not silently drift out of sync with this file. */
export function computeBudgetDataLength(kind: ComputeBudgetInstruction): number {
  switch (kind) {
    case ComputeBudgetInstruction.RequestUnits:
      return getRequestUnitsInstructionDataDecoder().fixedSize;
    case ComputeBudgetInstruction.RequestHeapFrame:
      return getRequestHeapFrameInstructionDataDecoder().fixedSize;
    case ComputeBudgetInstruction.SetComputeUnitLimit:
      return getSetComputeUnitLimitInstructionDataDecoder().fixedSize;
    case ComputeBudgetInstruction.SetComputeUnitPrice:
      return getSetComputeUnitPriceInstructionDataDecoder().fixedSize;
    case ComputeBudgetInstruction.SetLoadedAccountsDataSizeLimit:
      return getSetLoadedAccountsDataSizeLimitInstructionDataDecoder().fixedSize;
  }
}

/**
 * The exact union of addresses a CORRECTLY shaped transaction references: every named account
 * on every instruction the validator can ever accept, deduplicated, plus the ComputeBudget
 * program's own address when at least one such instruction was present. `initSubscriptionAuthority`
 * contributes no address not already in this set (its six accounts are a subset of
 * `subscribe`'s and the pulls' own), so its presence or absence never changes the answer.
 *
 * Compared against `compiled.staticAccounts` for exact equality: every account has ALREADY
 * been checked by address at its own named position by the time this runs, so the only thing
 * left for this check to catch is an account riding along UNREFERENCED by anything checked —
 * the only way left, besides a role flag, for a payer to plant something (another payment's
 * reference; a decoy account) in a transaction a co-signer will sign.
 */
function expectedStaticAccounts(
  expectation: SubscribeExpectation,
  eventAuthority: string,
  hadComputeBudget: boolean,
): Set<string> {
  const accounts = new Set<string>([
    expectation.payerWallet,
    expectation.puller,
    SUBSCRIPTIONS_PROGRAM_ID,
    SYSTEM_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
    expectation.mint,
    expectation.payerTokenAccount,
    expectation.planOwner,
    expectation.planAddress,
    expectation.subscriptionAddress,
    expectation.authorityAddress,
    eventAuthority,
    expectation.recipientTokenAccount,
    expectation.reference,
  ]);
  if (feeRecipientShareOf(expectation) > 0n && expectation.feeRecipientTokenAccount) {
    accounts.add(expectation.feeRecipientTokenAccount);
  }
  if (hadComputeBudget) accounts.add(COMPUTE_BUDGET_PROGRAM_ADDRESS);
  return accounts;
}

/**
 * `initSubscriptionAuthority`'s own checks: shape (account count, exact data length), then
 * every named account by address. Returns the refusal, or `null` when everything passed.
 */
function checkInit(
  instruction: SubscribeMessageInstruction,
  expectation: SubscribeExpectation,
): { ok: false; reason: SubscribeValidationFailure } | null {
  const accounts = instruction.accounts ?? [];
  // A SEVENTH account is the optional rent sponsor, and it must be a WRITABLE SIGNER
  // (`resolve_optional_payer`, helpers/system.rs). The builder never adds one. If the puller
  // sat there marked writable, the co-signer's own signature would pay the rent for the
  // payer's new subscription-authority account out of the puller's SOL — this exact count is
  // what stands between that and a payer simply asking for it.
  if (accounts.length !== INIT_AUTHORITY_NAMED_ACCOUNTS) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  const data = instruction.data as Uint8Array | undefined;
  if (!data || data.length !== getInitSubscriptionAuthorityInstructionDataDecoder().fixedSize) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  const parsed = parseSubscriptionsInstruction(instruction as never);
  // NOT dead code despite being provably unreachable at RUNTIME (mutation testing proves it —
  // the caller already confirmed this instruction's kind via `identifySubscriptionsInstruction`
  // before calling `checkInit`, and this parse determines `instructionType` by calling that
  // SAME function on the SAME bytes internally, so the two can never disagree): TypeScript
  // needs this check to NARROW `parsed`'s discriminated union before `parsed.accounts.*` below
  // type-checks at all. Kept for the compiler, not the runtime, which is why no test can
  // exercise its `false` branch.
  if (parsed.instructionType !== SubscriptionsInstruction.InitSubscriptionAuthority) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  if (parsed.accounts.subscriptionAuthority.address !== expectation.authorityAddress) {
    return { ok: false, reason: 'wrong_authority' };
  }
  if (parsed.accounts.owner.address !== expectation.payerWallet) {
    return { ok: false, reason: 'wrong_delegator' };
  }
  // The ATA the delegation is actually set up FOR. If it differs from the account the pulls
  // draw from, the charge simply fails on chain for want of a delegate — no funds can move
  // either way — but "exactly what was asked for" means this is refused here, structurally,
  // rather than discovered later as a failed charge.
  if (parsed.accounts.userAta.address !== expectation.payerTokenAccount) {
    return { ok: false, reason: 'wrong_delegator' };
  }
  if (parsed.accounts.tokenMint.address !== expectation.mint) {
    return { ok: false, reason: 'wrong_terms' };
  }
  if (parsed.accounts.systemProgram.address !== SYSTEM_PROGRAM_ADDRESS) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  if (parsed.accounts.tokenProgram.address !== TOKEN_PROGRAM_ADDRESS) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  return null;
}

/** `subscribe`'s own checks: shape, every named account, then all seven `subscribeData` fields
 *  — the terms the payer's signature actually commits to. */
function checkSubscribe(
  instruction: SubscribeMessageInstruction,
  expectation: SubscribeExpectation,
  eventAuthority: string,
): { ok: false; reason: SubscribeValidationFailure } | null {
  const accounts = instruction.accounts ?? [];
  // A NINTH account on subscribe is the optional rent payer, and — same as init's seventh —
  // it must be a WRITABLE SIGNER. The builder never adds one; a payer who adds one, with the
  // puller sitting there, is asking the co-signer's key to pay their rent. This exact count is
  // what refuses it.
  if (accounts.length !== SUBSCRIBE_NAMED_ACCOUNTS) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  const data = instruction.data as Uint8Array | undefined;
  if (!data || data.length !== getSubscribeInstructionDataDecoder().fixedSize) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  const parsed = parseSubscriptionsInstruction(instruction as never);
  // Kept for TypeScript's narrowing, provably unreachable at runtime — see `checkInit`'s
  // identical comment.
  if (parsed.instructionType !== SubscriptionsInstruction.Subscribe) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  if (
    parsed.accounts.subscriber.address !== expectation.payerWallet ||
    parsed.accounts.merchant.address !== expectation.planOwner
  ) {
    return { ok: false, reason: 'wrong_delegator' };
  }
  if (parsed.accounts.planPda.address !== expectation.planAddress) {
    return { ok: false, reason: 'wrong_plan' };
  }
  if (parsed.accounts.subscriptionPda.address !== expectation.subscriptionAddress) {
    return { ok: false, reason: 'wrong_subscription' };
  }
  if (parsed.accounts.subscriptionAuthorityPda.address !== expectation.authorityAddress) {
    return { ok: false, reason: 'wrong_authority' };
  }
  if (parsed.accounts.systemProgram.address !== SYSTEM_PROGRAM_ADDRESS) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  if (parsed.accounts.eventAuthority.address !== eventAuthority) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  if (parsed.accounts.selfProgram.address !== SUBSCRIPTIONS_PROGRAM_ID) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  // THE fields the payer's signature commits to. All seven, every time.
  const subscribeData = parsed.data.subscribeData;
  if (
    subscribeData.planId !== expectation.planId ||
    subscribeData.planBump !== expectation.planBump ||
    (subscribeData.expectedMint as string) !== expectation.mint ||
    subscribeData.expectedAmount !== expectation.capAmount ||
    subscribeData.expectedPeriodHours !== BigInt(expectation.periodHours) ||
    subscribeData.expectedCreatedAt !== expectation.termsCreatedAt ||
    subscribeData.expectedSubscriptionAuthorityInitId !== expectation.authorityInitId
  ) {
    return { ok: false, reason: 'wrong_terms' };
  }
  return null;
}

/** One `transferSubscription` pull's own checks. `role` says which of the two slots this is:
 *  the recipient pull (carries the reference, exact account count `TRANSFER_NAMED_ACCOUNTS + 1`)
 *  or the fee recipient pull (no extras, exactly `TRANSFER_NAMED_ACCOUNTS`) — decided by POSITION in
 *  the fixed instruction order, not by which destination the bytes happen to name. */
function checkPull(
  instruction: SubscribeMessageInstruction,
  expectation: SubscribeExpectation,
  eventAuthority: string,
  role: { destination: string; amount: bigint; requireReference: boolean },
): { ok: false; reason: SubscribeValidationFailure } | null {
  const accounts = instruction.accounts ?? [];
  const expectedAccountCount = TRANSFER_NAMED_ACCOUNTS + (role.requireReference ? 1 : 0);
  // Never fewer than the ten named accounts, and never a single account more than this SLOT
  // is allowed — the reference on the recipient pull, nothing at all on the fee recipient pull.
  // THIS is the puller's own signature on the line: a pull whose shape the builder did not
  // choose is refused before the puller ever signs it, whether or not the on-chain program
  // would also reject it.
  if (accounts.length !== expectedAccountCount) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  const data = instruction.data as Uint8Array | undefined;
  if (!data || data.length !== getTransferSubscriptionInstructionDataDecoder().fixedSize) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  const parsed = parseSubscriptionsInstruction(instruction as never);
  // Kept for TypeScript's narrowing, provably unreachable at runtime — see `checkInit`'s
  // identical comment.
  if (parsed.instructionType !== SubscriptionsInstruction.TransferSubscription) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  if (
    parsed.accounts.subscriptionPda.address !== expectation.subscriptionAddress ||
    parsed.accounts.planPda.address !== expectation.planAddress
  ) {
    return { ok: false, reason: 'wrong_subscription' };
  }
  if (parsed.accounts.subscriptionAuthority.address !== expectation.authorityAddress) {
    return { ok: false, reason: 'wrong_authority' };
  }
  if (
    parsed.accounts.delegatorAta.address !== expectation.payerTokenAccount ||
    (parsed.data.transferData.delegator as string) !== expectation.payerWallet ||
    (parsed.data.transferData.mint as string) !== expectation.mint
  ) {
    return { ok: false, reason: 'wrong_delegator' };
  }
  // The caller must be the expected puller. A pull naming anyone else would fail on chain as
  // Unauthorized (130) — but refusing to co-sign it is cheaper and does not spend the payer's
  // fee finding out.
  if (parsed.accounts.caller.address !== expectation.puller) {
    return { ok: false, reason: 'wrong_caller' };
  }
  if (parsed.accounts.tokenMint.address !== expectation.mint) {
    return { ok: false, reason: 'wrong_terms' };
  }
  // Same posture as `initSubscriptionAuthority`'s and `subscribe`'s program-identity accounts:
  // the puller is a REQUIRED SIGNER of this instruction, so a substituted program here is a
  // program the puller's own key would be asked to sign against.
  if (parsed.accounts.tokenProgram.address !== TOKEN_PROGRAM_ADDRESS) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  if (parsed.accounts.eventAuthority.address !== eventAuthority) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  if (parsed.accounts.selfProgram.address !== SUBSCRIPTIONS_PROGRAM_ID) {
    return { ok: false, reason: 'unexpected_instruction' };
  }
  if (parsed.accounts.receiverAta.address !== role.destination) {
    return { ok: false, reason: 'wrong_destination' };
  }
  if (parsed.data.transferData.amount !== role.amount) {
    return { ok: false, reason: 'wrong_amount' };
  }
  if (role.requireReference) {
    // Without the reference the payment cannot be found by its reference address.
    const extra: string[] = accounts.slice(TRANSFER_NAMED_ACCOUNTS).map((meta) => meta.address);
    if (!extra.includes(expectation.reference)) return { ok: false, reason: 'missing_reference' };
  }
  return null;
}

async function checkSignedSubscribe(
  base64: string,
  expectation: SubscribeExpectation,
): Promise<SubscribeValidation> {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  // Checked BEFORE decompiling: a v0 message carrying address lookup tables throws inside
  // `decompileTransactionMessage` — there is no RPC access to resolve one here — which the
  // outer try/catch would otherwise report as the far less specific `undecodable`.
  if (compiled.version !== 'legacy') return { ok: false, reason: 'not_legacy' };
  // The compiled message is a LOSSY view (it is what `staticAccounts` + `header` +
  // `instructions` express); bytes the payer signed but that no compiled field accounts for —
  // e.g. trailing bytes after the message the kit decoder still folds into `messageBytes` —
  // would otherwise verify against a signature over MORE than what every check below inspects
  // (the same gap `validateSignedPayerAction` closes). Re-encoding and comparing byte-for-byte
  // closes that gap here too.
  if (
    !bytesEqual(
      getCompiledTransactionMessageEncoder().encode(compiled) as unknown as Uint8Array,
      transaction.messageBytes as unknown as Uint8Array,
    )
  ) {
    return { ok: false, reason: 'trailing_bytes' };
  }
  if (compiled.lifetimeToken !== expectation.blockhash) {
    return { ok: false, reason: 'wrong_blockhash' };
  }

  const message = decompileTransactionMessage(compiled);
  if (message.feePayer.address !== expectation.payerWallet) {
    return { ok: false, reason: 'wrong_fee_payer' };
  }

  const eventAuthority = await deriveEventAuthorityAddress();
  const instructions = message.instructions;
  let index = 0;
  let hadComputeBudget = false;

  // Phase 0: zero or more ComputeBudget instructions, as a PREFIX only — a wallet's own
  // priority fee, which costs the co-signer nothing (the payer is the fee payer) and moves no
  // funds. Everything about one beyond "a known kind, zero accounts, exactly the right number
  // of data bytes" is deliberately uninspected: it is the validator's one allowance. ZERO
  // accounts specifically: attaching accounts here can promote the puller to a writable
  // signer, or plant another payment's reference — an address's role in the compiled message
  // is the UNION of every instruction that names it, so even an otherwise-inert instruction
  // can escalate a role or smuggle a key in.
  while (
    index < instructions.length &&
    instructions[index].programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS
  ) {
    const instr = instructions[index];
    if ((instr.accounts ?? []).length !== 0) return { ok: false, reason: 'unexpected_instruction' };
    // `identifyComputeBudgetInstruction` throws for anything it does not recognise (proven by
    // direct probe, not assumed) — folded into the SAME length check below rather than its own
    // early return, because ANY throw here leaves `expectedLength` `undefined`, which
    // `data.length` (always a number) can never equal, so a separate early return here could
    // never fire on input the length check below would not ALSO refuse — provably dead code,
    // not merely untested.
    let expectedLength: number | undefined;
    try {
      expectedLength = computeBudgetDataLength(identifyComputeBudgetInstruction(instr as { data: Uint8Array }));
    } catch {
      expectedLength = undefined;
    }
    const data = instr.data as Uint8Array | undefined;
    if (!data || data.length !== expectedLength) {
      return { ok: false, reason: 'unexpected_instruction' };
    }
    hadComputeBudget = true;
    index += 1;
  }

  // Phase 1: `initSubscriptionAuthority`, present iff the wallet had none, right after the
  // ComputeBudget prefix and nowhere else.
  if (!expectation.authorityExists) {
    const instr = instructions[index];
    if (!instr) return { ok: false, reason: 'missing_authority_init' };
    if (instr.programAddress !== SUBSCRIPTIONS_PROGRAM_ID) {
      return { ok: false, reason: 'unexpected_program' };
    }
    if (
      identifySubscriptionsInstruction(instr as { data: Uint8Array }) !==
      SubscriptionsInstruction.InitSubscriptionAuthority
    ) {
      return { ok: false, reason: 'missing_authority_init' };
    }
    const failure = checkInit(instr, expectation);
    if (failure) return failure;
    index += 1;
  } else {
    const instr = instructions[index];
    if (
      instr &&
      instr.programAddress === SUBSCRIPTIONS_PROGRAM_ID &&
      identifySubscriptionsInstruction(instr as { data: Uint8Array }) ===
        SubscriptionsInstruction.InitSubscriptionAuthority
    ) {
      return { ok: false, reason: 'unexpected_authority_init' };
    }
  }

  // Phase 2: `subscribe`, exactly once, right here.
  {
    const instr = instructions[index];
    if (!instr) return { ok: false, reason: 'missing_subscribe' };
    if (instr.programAddress !== SUBSCRIPTIONS_PROGRAM_ID) {
      return { ok: false, reason: 'unexpected_program' };
    }
    if (
      identifySubscriptionsInstruction(instr as { data: Uint8Array }) !== SubscriptionsInstruction.Subscribe
    ) {
      return { ok: false, reason: 'missing_subscribe' };
    }
    const failure = checkSubscribe(instr, expectation, eventAuthority);
    if (failure) return failure;
    index += 1;
  }

  // Phase 3: the recipient pull, exactly once, right here — the reference rides on THIS one.
  {
    const instr = instructions[index];
    if (!instr) return { ok: false, reason: 'wrong_transfer_count' };
    if (instr.programAddress !== SUBSCRIPTIONS_PROGRAM_ID) {
      return { ok: false, reason: 'unexpected_program' };
    }
    if (
      identifySubscriptionsInstruction(instr as { data: Uint8Array }) !==
      SubscriptionsInstruction.TransferSubscription
    ) {
      return { ok: false, reason: 'wrong_transfer_count' };
    }
    const failure = checkPull(instr, expectation, eventAuthority, {
      destination: expectation.recipientTokenAccount,
      amount: expectation.amount,
      requireReference: true,
    });
    if (failure) return failure;
    index += 1;
  }

  // Phase 4: the fee recipient pull (fee + network fee), present iff — and only iff — it is non-zero.
  if (feeRecipientShareOf(expectation) > 0n) {
    const instr = instructions[index];
    if (!instr) return { ok: false, reason: 'wrong_transfer_count' };
    if (instr.programAddress !== SUBSCRIPTIONS_PROGRAM_ID) {
      return { ok: false, reason: 'unexpected_program' };
    }
    if (
      identifySubscriptionsInstruction(instr as { data: Uint8Array }) !==
      SubscriptionsInstruction.TransferSubscription
    ) {
      return { ok: false, reason: 'wrong_transfer_count' };
    }
    if (!expectation.feeRecipientTokenAccount) return { ok: false, reason: 'wrong_transfer_count' };
    const failure = checkPull(instr, expectation, eventAuthority, {
      destination: expectation.feeRecipientTokenAccount,
      amount: feeRecipientShareOf(expectation),
      requireReference: false,
    });
    if (failure) return failure;
    index += 1;
  }

  // Phase 5: nothing else. A duplicate subscribe, a third pull to some other destination, a
  // memo, anything trailing — the fixed order above already consumed everything this
  // transaction is allowed to contain.
  if (index !== instructions.length) return { ok: false, reason: 'unexpected_instruction' };

  const expected = expectedStaticAccounts(expectation, eventAuthority, hadComputeBudget);
  const actual = compiled.staticAccounts as readonly string[];
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    return { ok: false, reason: 'wrong_accounts' };
  }

  // The signer set: exactly {payer, puller}, the puller required and NON-WRITABLE. A role,
  // not just an address, can cost the co-signer real money: `subscribe`'s optional 9th
  // account and `initSubscriptionAuthority`'s optional 7th are RENT PAYERS that must be
  // writable signers — but those slots are already refused above by their exact account
  // counts (`checkInit`/`checkSubscribe`), so what is left for THIS check to catch is a role
  // change on an EXISTING position: the puller demoted to a non-signer (which later makes the
  // co-signing step throw, on demand of any payer), promoted to writable (costs nothing today
  // only because no account it signs ever reaches a System Program CPI, but a flag that is not
  // needed is a flag not granted), or a third, unfilled signer slot.
  if (
    compiled.header.numSignerAccounts !== 2 ||
    compiled.header.numReadonlySignerAccounts !== 1 ||
    compiled.staticAccounts[0] !== expectation.payerWallet ||
    compiled.staticAccounts[1] !== expectation.puller
  ) {
    return { ok: false, reason: 'wrong_signers' };
  }

  // The WRITABLE set, not just the address set: a legacy message lists signers, then writable
  // non-signers, then read-only non-signers, so a payer could re-mark an account (the
  // recipient's token account read-only, the plan or the mint writable) and every address
  // check above would still pass — the co-signer would sign bytes that can only fail on chain.
  // The expected set is read off this module's OWN build of the same expectation, so it
  // follows the SDK's account roles instead of a hand-written list that could drift from them.
  if (compiled.header.numReadonlyNonSignerAccounts > actual.length - compiled.header.numSignerAccounts) {
    return { ok: false, reason: 'wrong_accounts' };
  }
  const writable = writableNonSigners(actual, compiled.header);
  const expectedWritable = await expectedWritableNonSigners(expectation);
  if (writable.length !== expectedWritable.size || writable.some((key) => !expectedWritable.has(key))) {
    return { ok: false, reason: 'wrong_accounts' };
  }

  const signature = transaction.signatures[address(expectation.payerWallet)];
  if (!signature) return { ok: false, reason: 'missing_signature' };
  // verifyWalletSignature, not raw WebCrypto: it refuses a small-order or non-canonical payer
  // key, for which a signature can be forged with no private key.
  if (
    !(await verifyWalletSignature(
      expectation.payerWallet,
      transaction.messageBytes as unknown as Uint8Array,
      signature,
    ))
  ) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true, signature: getSignatureFromTransaction(transaction) };
}

/** The first charge pays the recipient something, and all of it (price + fee + network fee) fits
 *  under the cap the payer approves: equal for a full-price subscribe, below it for a discounted
 *  one (the on-chain probe: a pull under the cap lands, one over it fails). */
function firstChargeWithinCap(expectation: {
  amount: bigint;
  feeAmount: bigint;
  networkFeeAmount: bigint;
  capAmount: bigint;
}): boolean {
  // Non-negative shares too: a negative fee would let the recipient pull alone exceed the cap.
  return (
    expectation.amount > 0n &&
    expectation.feeAmount >= 0n &&
    expectation.networkFeeAmount >= 0n &&
    expectation.amount + feeRecipientShareOf(expectation) <= expectation.capAmount
  );
}

/** What the first charge pulls to the fee recipient: the fee and the network fee, in one pull. */
function feeRecipientShareOf(expectation: { feeAmount: bigint; networkFeeAmount: bigint }): bigint {
  return expectation.feeAmount + expectation.networkFeeAmount;
}
