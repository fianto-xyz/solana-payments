import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
  identifyComputeBudgetInstruction,
} from '@solana-program/compute-budget';
import {
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
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import {
  getCancelSubscriptionInstruction,
  getCancelSubscriptionInstructionDataDecoder,
  getInitSubscriptionAuthorityInstruction,
  getInitSubscriptionAuthorityInstructionDataDecoder,
  getRevokeDelegationInstructionDataDecoder,
  getRevokeSubscriptionOverlayInstruction,
  identifySubscriptionsInstruction,
  SubscriptionsInstruction,
} from '@solana/subscriptions';
import { bytesEqual } from '../bytes-equal.js';
import { MAX_SIGNED_TRANSACTION_BASE64 } from '../payment-transaction.js';
import { COMPUTE_BUDGET_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '../solana.constants.js';
import { verifyWalletSignature } from '../wallet-signature.js';
import { deriveEventAuthorityAddress } from './addresses.js';
import { computeBudgetDataLength } from './subscribe-transaction.js';
import { SUBSCRIPTIONS_PROGRAM_ID } from './subscriptions-program.constants.js';

const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111';

/**
 * What the payer is asked to sign for a cancel, revoke or reauthorize, and therefore exactly what
 * must come back. Every field is compared; nothing is re-derived at validation time. Store it
 * when the transaction is BUILT and read it back when the signed transaction is SUBMITTED.
 *
 * No key other than the payer's signs any of these (program source: the only signer
 * `CancelSubscription`, `RevokeDelegation` and `InitSubscriptionAuthority` require is the
 * subscriber / user). The payer is also the fee payer.
 */
export type PayerActionExpectation =
  | {
      /** cancelSubscription (discriminator 12). */
      kind: 'cancel';
      payerWallet: string;
      planAddress: string;
      subscriptionAddress: string;
      blockhash: string;
    }
  | {
      /** revokeSubscription = RevokeDelegation (discriminator 3) with a trailing planPda. */
      kind: 'revoke';
      payerWallet: string;
      planAddress: string;
      subscriptionAddress: string;
      blockhash: string;
    }
  | {
      /** initSubscriptionAuthority (discriminator 0) over the EXISTING authority. */
      kind: 'reauthorize';
      payerWallet: string;
      authorityAddress: string;
      mint: string;
      payerTokenAccount: string;
      blockhash: string;
    };

export interface PayerActionTransactionInput {
  expectation: PayerActionExpectation;
  lastValidBlockHeight: bigint;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: bigint;
}

export type PayerActionValidationFailure =
  | 'too_large'
  | 'undecodable'
  | 'not_legacy'
  | 'wrong_blockhash'
  | 'wrong_fee_payer'
  | 'unexpected_program'
  | 'unexpected_instruction'
  | 'missing_action'
  | 'wrong_accounts'
  | 'wrong_signers'
  | 'missing_signature'
  | 'bad_signature'
  /** The compiled message, re-encoded with the SDK's own encoder, does not reproduce
   *  `messageBytes` byte for byte — bytes the payer signed but that no compiled field
   *  accounts for. */
  | 'trailing_bytes';

export type PayerActionValidation =
  | { ok: true; signature: string }
  | { ok: false; reason: PayerActionValidationFailure };

/** The one program instruction an action is: which, how many data bytes, its accounts in the
 *  SDK's declared order, and which non-signer accounts are writable. */
interface ActionShape {
  instruction: SubscriptionsInstruction;
  dataLength: number;
  accounts: readonly string[];
  writable: ReadonlySet<string>;
}

async function shapeOf(expectation: PayerActionExpectation): Promise<ActionShape> {
  switch (expectation.kind) {
    case 'cancel':
      return {
        instruction: SubscriptionsInstruction.CancelSubscription,
        dataLength: getCancelSubscriptionInstructionDataDecoder().fixedSize,
        // subscriber, planPda, subscriptionPda, eventAuthority, selfProgram
        accounts: [
          expectation.payerWallet,
          expectation.planAddress,
          expectation.subscriptionAddress,
          await deriveEventAuthorityAddress(),
          SUBSCRIPTIONS_PROGRAM_ID,
        ],
        writable: new Set([expectation.subscriptionAddress]),
      };
    case 'revoke':
      return {
        instruction: SubscriptionsInstruction.RevokeDelegation,
        dataLength: getRevokeDelegationInstructionDataDecoder().fixedSize,
        // authority, delegationAccount, then the subscription branch's trailing planPda. No
        // `receiver`: build this only for a subscription whose recorded rent payer IS the
        // payer, and the program then pays the rent back to the signer.
        accounts: [expectation.payerWallet, expectation.subscriptionAddress, expectation.planAddress],
        writable: new Set([expectation.subscriptionAddress]),
      };
    case 'reauthorize':
      return {
        instruction: SubscriptionsInstruction.InitSubscriptionAuthority,
        dataLength: getInitSubscriptionAuthorityInstructionDataDecoder().fixedSize,
        // owner, subscriptionAuthority, tokenMint, userAta, systemProgram, tokenProgram. No
        // seventh (the optional rent sponsor): the authority already exists, so there is no rent.
        accounts: [
          expectation.payerWallet,
          expectation.authorityAddress,
          expectation.mint,
          expectation.payerTokenAccount,
          SYSTEM_PROGRAM_ADDRESS,
          TOKEN_PROGRAM_ADDRESS,
        ],
        writable: new Set([expectation.authorityAddress, expectation.payerTokenAccount]),
      };
  }
}

async function actionInstruction(
  expectation: PayerActionExpectation,
  payer: TransactionSigner,
): Promise<Instruction> {
  switch (expectation.kind) {
    case 'cancel':
      return getCancelSubscriptionInstruction({
        subscriber: payer,
        planPda: address(expectation.planAddress),
        subscriptionPda: address(expectation.subscriptionAddress),
        eventAuthority: address(await deriveEventAuthorityAddress()),
      });
    case 'revoke':
      return getRevokeSubscriptionOverlayInstruction({
        authority: payer,
        planPda: address(expectation.planAddress),
        subscriptionPda: address(expectation.subscriptionAddress),
      });
    case 'reauthorize':
      return getInitSubscriptionAuthorityInstruction({
        owner: payer,
        subscriptionAuthority: address(expectation.authorityAddress),
        tokenMint: address(expectation.mint),
        userAta: address(expectation.payerTokenAccount),
        tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
      });
  }
}

/**
 * `[setComputeUnitLimit, setComputeUnitPrice, <the action>]`, legacy, fee payer = the payer.
 * The same shape `validateSignedPayerAction` accepts, so this builder's output always validates.
 */
export async function buildPayerActionTransaction(
  input: PayerActionTransactionInput,
): Promise<{ base64: string }> {
  const { expectation } = input;
  const action = await actionInstruction(expectation, createNoopSigner(address(expectation.payerWallet)));
  const message = pipe(
    createTransactionMessage({ version: 'legacy' as const }),
    (current) => setTransactionMessageFeePayer(address(expectation.payerWallet), current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: expectation.blockhash as never, lastValidBlockHeight: input.lastValidBlockHeight },
        current,
      ),
    (current) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: input.computeUnitLimit }),
          getSetComputeUnitPriceInstruction({ microLamports: input.computeUnitPriceMicroLamports }),
          action,
        ],
        current,
      ),
  );
  return { base64: getBase64EncodedWireTransaction(compileTransaction(message)) };
}

/**
 * The WHOLE message, the way `validateSignedSubscribe` binds a subscribe:
 *   - legacy, the expected blockhash, the payer as fee payer;
 *   - any number of ComputeBudget instructions as a PREFIX, each with zero accounts and the
 *     exact data length of its kind (a wallet's own priority fee — paid by the payer);
 *   - then exactly ONE Subscriptions-program instruction of the expected kind, with exactly the
 *     expected accounts in the SDK's order and exactly the expected data length;
 *   - then nothing;
 *   - the static account list is exactly the union of what those instructions reference;
 *   - exactly one signer — the payer — and exactly the expected accounts writable;
 *   - the payer's ed25519 signature over the message.
 *
 * No other key signs these, so a wrong shape here could only ever cost the payer — but the
 * caller BROADCASTS it, records it and acts on the subscription change it makes, so "exactly
 * what was asked for" is the only thing it should send. Every decode or interpretation failure
 * is a refusal.
 */
export async function validateSignedPayerAction(
  base64: string,
  expectation: PayerActionExpectation,
): Promise<PayerActionValidation> {
  if (base64.length > MAX_SIGNED_TRANSACTION_BASE64) return { ok: false, reason: 'too_large' };
  try {
    return await checkSignedPayerAction(base64, expectation);
  } catch {
    return { ok: false, reason: 'undecodable' };
  }
}

function refuse(reason: PayerActionValidationFailure): PayerActionValidation {
  return { ok: false, reason };
}

/**
 * The header's three counts must be internally consistent BEFORE anything downstream indexes
 * into `staticAccounts` with them: a header claiming more read-only non-signers than there
 * are non-signer slots left drives the writable-set slice's end index negative, which silently
 * narrows the slice instead of failing — accepting bytes that differ from what was built. The runtime's own sanitizer would refuse such a transaction, but this validator's
 * whole job is to say so FIRST, never to depend on that.
 */
function headerBoundsAreSane(
  header: {
    numSignerAccounts: number;
    numReadonlySignerAccounts: number;
    numReadonlyNonSignerAccounts: number;
  },
  staticAccountsLength: number,
): boolean {
  if (header.numSignerAccounts > staticAccountsLength) return false;
  if (header.numReadonlySignerAccounts > header.numSignerAccounts) return false;
  if (header.numReadonlyNonSignerAccounts > staticAccountsLength - header.numSignerAccounts) {
    return false;
  }
  return true;
}

async function checkSignedPayerAction(
  base64: string,
  expectation: PayerActionExpectation,
): Promise<PayerActionValidation> {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (compiled.version !== 'legacy') return refuse('not_legacy');
  if (!headerBoundsAreSane(compiled.header, compiled.staticAccounts.length)) {
    return refuse('wrong_signers');
  }
  // The compiled message is a LOSSY view (it is what `staticAccounts` + `header` +
  // `instructions` express); bytes the payer signed but that no compiled field accounts for —
  // e.g. trailing bytes after the message the kit decoder still folds into `messageBytes` —
  // would otherwise verify against a signature over MORE than what every check below inspects.
  // Re-encoding and comparing byte-for-byte closes that gap.
  if (
    !bytesEqual(
      getCompiledTransactionMessageEncoder().encode(compiled) as unknown as Uint8Array,
      transaction.messageBytes as unknown as Uint8Array,
    )
  ) {
    return refuse('trailing_bytes');
  }
  if (compiled.lifetimeToken !== expectation.blockhash) return refuse('wrong_blockhash');
  const message = decompileTransactionMessage(compiled);
  if (message.feePayer.address !== expectation.payerWallet) return refuse('wrong_fee_payer');

  const shape = await shapeOf(expectation);
  const instructions = message.instructions;
  let index = 0;
  let hadComputeBudget = false;
  while (
    index < instructions.length &&
    instructions[index].programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS
  ) {
    const instruction = instructions[index];
    if ((instruction.accounts ?? []).length !== 0) return refuse('unexpected_instruction');
    let expectedLength: number | undefined;
    try {
      expectedLength = computeBudgetDataLength(
        identifyComputeBudgetInstruction(instruction as { data: Uint8Array }),
      );
    } catch {
      expectedLength = undefined;
    }
    const data = instruction.data as Uint8Array | undefined;
    if (!data || data.length !== expectedLength) return refuse('unexpected_instruction');
    hadComputeBudget = true;
    index += 1;
  }

  const action = instructions[index];
  if (!action) return refuse('missing_action');
  if (action.programAddress !== SUBSCRIPTIONS_PROGRAM_ID) return refuse('unexpected_program');
  if (identifySubscriptionsInstruction(action as { data: Uint8Array }) !== shape.instruction) {
    return refuse('missing_action');
  }
  const data = action.data as Uint8Array | undefined;
  if (!data || data.length !== shape.dataLength) return refuse('unexpected_instruction');
  const accounts = (action.accounts ?? []).map((meta) => meta.address as string);
  if (
    accounts.length !== shape.accounts.length ||
    accounts.some((account, position) => account !== shape.accounts[position])
  ) {
    return refuse('wrong_accounts');
  }
  index += 1;
  if (index !== instructions.length) return refuse('unexpected_instruction');

  const expected = new Set<string>([...shape.accounts, SUBSCRIPTIONS_PROGRAM_ID]);
  if (hadComputeBudget) expected.add(COMPUTE_BUDGET_PROGRAM_ADDRESS);
  const statics = compiled.staticAccounts as readonly string[];
  if (statics.length !== expected.size || statics.some((key) => !expected.has(key))) {
    return refuse('wrong_accounts');
  }
  if (
    compiled.header.numSignerAccounts !== 1 ||
    compiled.header.numReadonlySignerAccounts !== 0 ||
    statics[0] !== expectation.payerWallet
  ) {
    return refuse('wrong_signers');
  }
  // A legacy message lists signers first, then writable non-signers, then read-only
  // non-signers — so this slice IS the writable set, and a role escalation (a plan account
  // marked writable) or demotion shows up here even though every address matched above.
  const writable = statics.slice(1, statics.length - compiled.header.numReadonlyNonSignerAccounts);
  if (writable.length !== shape.writable.size || writable.some((key) => !shape.writable.has(key))) {
    return refuse('wrong_accounts');
  }

  const signature = transaction.signatures[address(expectation.payerWallet)];
  if (!signature) return refuse('missing_signature');
  if (
    !(await verifyWalletSignature(
      expectation.payerWallet,
      // messageBytes is a branded ReadonlyUint8Array (TransactionMessageBytes); it never
      // overlaps Uint8Array's mutating methods, so tsc requires the trip through `unknown`
      // it suggests. verifyWalletSignature only ever reads it.
      transaction.messageBytes as unknown as Uint8Array,
      signature,
    ))
  ) {
    return refuse('bad_signature');
  }
  return { ok: true, signature: getSignatureFromTransaction(transaction) };
}
