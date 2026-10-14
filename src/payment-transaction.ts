import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import {
  getTransferCheckedInstruction,
  getTransferCheckedInstructionDataDecoder,
  TRANSFER_CHECKED_DISCRIMINATOR,
} from '@solana-program/token';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
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
import { bytesEqual } from './bytes-equal.js';
import { verifyWalletSignature } from './wallet-signature.js';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from './solana.constants.js';

export interface PaymentTransactionInput {
  payerWallet: string;
  payerTokenAccount: string;
  recipientTokenAccount: string;
  /** Null exactly when feeAmount is 0: a zero fee moves no money and needs no account. */
  feeRecipientTokenAccount: string | null;
  mint: string;
  decimals: number;
  amount: bigint;
  feeAmount: bigint;
  /** 32-byte base58 key, carried as a read-only account so the payment can be found by address. */
  reference: string;
  blockhash: string;
  lastValidBlockHeight: bigint;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: bigint;
}

export interface BuiltPaymentTransaction {
  base64: string;
  lastValidBlockHeight: bigint;
}

/** What a returned transaction is compared against; the build-only settings are not part of it. */
export type PaymentExpectation = Omit<
  PaymentTransactionInput,
  'computeUnitLimit' | 'computeUnitPriceMicroLamports' | 'lastValidBlockHeight'
>;

export type PaymentValidationFailure =
  | 'too_large'
  | 'undecodable'
  | 'not_legacy'
  | 'wrong_blockhash'
  | 'wrong_fee_payer'
  | 'unexpected_program'
  | 'unexpected_token_instruction'
  | 'wrong_transfer_count'
  | 'wrong_mint'
  | 'wrong_source'
  | 'wrong_amount'
  | 'missing_reference'
  | 'missing_signature'
  | 'bad_signature'
  /** The compiled message, re-encoded with the SDK's own encoder, does not reproduce
   *  `messageBytes` byte for byte — bytes the payer signed but that no compiled field
   *  accounts for. */
  | 'trailing_bytes';

export type PaymentValidation =
  | { ok: true; signature: string }
  | { ok: false; reason: PaymentValidationFailure };

/** A Solana transaction cannot exceed 1232 bytes; base64 of that is 1644 characters. */
export const MAX_SIGNED_TRANSACTION_BASE64 = 2_000;

const MINIMUM_TRANSFER_ACCOUNTS = 4;
// discriminator(1) + amount as u64(8) + decimals(1), per @solana-program/token's fixed-size
// transferChecked struct decoder. Any other length is not a transferChecked instruction, even
// if it starts with the right discriminator byte.
const TRANSFER_CHECKED_DATA_LENGTH = 10;

function transferInstruction(
  input: PaymentTransactionInput,
  destination: string,
  amount: bigint,
  reference: string | null,
) {
  const instruction = getTransferCheckedInstruction({
    source: address(input.payerTokenAccount),
    mint: address(input.mint),
    destination: address(destination),
    // The payer signs as the owner of their own token account; no delegate is involved.
    authority: address(input.payerWallet),
    amount,
    decimals: input.decimals,
  });
  if (!reference) return instruction;
  // Appended as an extra, read-only, non-signer account. The Token program ignores it; the
  // it lets anyone find this payment by address later (getSignaturesForAddress).
  return {
    ...instruction,
    accounts: [
      ...instruction.accounts,
      { address: address(reference), role: AccountRole.READONLY },
    ],
  };
}

/**
 * The transaction the payer is asked to sign: compute budget, the price to the recipient,
 * and the fee to the fee recipient when there is one. Fee payer is the payer: no other key
 * signs this transaction or pays for it. Legacy message, no lookup tables.
 */
export async function buildPaymentTransaction(
  input: PaymentTransactionInput,
): Promise<BuiltPaymentTransaction> {
  const instructions = [
    getSetComputeUnitLimitInstruction({ units: input.computeUnitLimit }),
    getSetComputeUnitPriceInstruction({ microLamports: input.computeUnitPriceMicroLamports }),
    transferInstruction(input, input.recipientTokenAccount, input.amount, input.reference),
  ];
  if (input.feeAmount > 0n && input.feeRecipientTokenAccount) {
    instructions.push(
      transferInstruction(input, input.feeRecipientTokenAccount, input.feeAmount, null),
    );
  }
  // Built with `pipe` rather than reassigning a single `let message` through each step: with
  // @solana/kit 8.3.0's conditional return types (each step's return type carries more
  // information than the last — feePayer, then lifetime, then instructions-within-size-limit),
  // reassigning into a `let` binding whose declared type is fixed at its first assignment
  // widens the value back to that first, less-specific type on every subsequent read, and
  // `tsc` (unlike vitest's looser transform) then rejects the final
  // `appendTransactionMessageInstructions`/`compileTransaction` calls as missing `feePayer`
  // and the size-limit brand. `pipe` avoids the intermediate binding entirely, so each step's
  // return type flows into the next by inference instead of through a re-widened variable.
  const message = pipe(
    createTransactionMessage({ version: 'legacy' as const }),
    (message) => setTransactionMessageFeePayer(address(input.payerWallet), message),
    (message) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: input.blockhash as never,
          lastValidBlockHeight: input.lastValidBlockHeight,
        },
        message,
      ),
    (message) => appendTransactionMessageInstructions(instructions, message),
  );
  return {
    base64: getBase64EncodedWireTransaction(compileTransaction(message)),
    lastValidBlockHeight: input.lastValidBlockHeight,
  };
}

interface ReadTransfer {
  source: string;
  mint: string;
  destination: string;
  authority: string;
  amount: bigint;
  decimals: number;
  extraAccounts: string[];
}

/**
 * Positional decode of a transferChecked instruction; null if it is not one. The payer fully
 * controls `instruction.data` and `.accounts`: a Token-program instruction whose data
 * is the single discriminator byte with no amount/decimals, or any other wrong length, used
 * to reach the u64 codec and throw — turning `submit` into a 500 before any signature check.
 * The exact-length check below rejects that input as "not a transfer the validator understands" before
 * decoding is even attempted; the try/catch is defence in depth for any other decode failure
 * this length check does not anticipate, so this function can never throw.
 *
 * Deliberately NOT validated: each account's `role` (writable/signer flags). The only account
 * whose signer-ness matters here is `authority` (accounts[3]), and its role
 * flag is not checked either — its ADDRESS is checked against `expectation.payerWallet`, and the payer's
 * address is already a required signer of the whole transaction as its fee payer (checked
 * above, before this loop ever runs). A transferChecked instruction whose `source`,
 * `destination` or `mint` account is mis-flagged (e.g. marked read-only when it should be
 * writable) is not something this gate needs to catch: the Token program itself enforces its
 * own account requirements and simply fails the instruction on-chain if they are wrong, and
 * "was this payment actually made" is decided ONLY by the finalized token-balance delta the
 * finalized token-balance delta read back from the chain, never by anything
 * this structural gate accepts. A wrong role flag can make a transaction fail to land; it can
 * never make it move money somewhere this gate did not already check the address of.
 */
function readTransfer(instruction: {
  data?: Uint8Array | ReadonlyUint8ArrayLike;
  accounts?: readonly { address: string }[];
}): ReadTransfer | null {
  const data = instruction.data;
  const accounts = instruction.accounts;
  if (!data || !accounts || accounts.length < MINIMUM_TRANSFER_ACCOUNTS) return null;
  if (data.length !== TRANSFER_CHECKED_DATA_LENGTH) return null;
  if (data[0] !== TRANSFER_CHECKED_DISCRIMINATOR) return null;
  try {
    const decoded = getTransferCheckedInstructionDataDecoder().decode(data as Uint8Array);
    return {
      source: accounts[0].address,
      mint: accounts[1].address,
      destination: accounts[2].address,
      authority: accounts[3].address,
      amount: decoded.amount,
      decimals: decoded.decimals,
      extraAccounts: accounts.slice(MINIMUM_TRANSFER_ACCOUNTS).map((meta) => meta.address),
    };
  } catch {
    return null;
  }
}

type ReadonlyUint8ArrayLike = { readonly [index: number]: number; readonly length: number };

/**
 * STRUCTURAL validation, never a byte comparison: a wallet may re-serialise what it signed,
 * so the meaning is checked instead. Everything the transaction can do must be something the
 * builder asked for — the fee payer, the two programs, each transfer's mint, decimals, source,
 * destination and amount, the reference, and the blockhash that was issued. Any disagreement is
 * a refusal to broadcast, which is the same thing as the payer not being charged.
 *
 * The bytes in `base64` are entirely payer-controlled and `expectation` is read back out of
 * the caller's own storage; neither is trusted to be well-formed. Everything past the size check runs
 * inside one try/catch so that ANY decode or interpretation failure — not just the
 * outer transaction envelope — comes back as a refusal, never an uncaught exception out of
 * the caller's submit handler.
 */
export async function validateSignedPayment(
  base64: string,
  expectation: PaymentExpectation,
): Promise<PaymentValidation> {
  if (base64.length > MAX_SIGNED_TRANSACTION_BASE64) return { ok: false, reason: 'too_large' };
  try {
    return await checkSignedPayment(base64, expectation);
  } catch {
    return { ok: false, reason: 'undecodable' };
  }
}

async function checkSignedPayment(
  base64: string,
  expectation: PaymentExpectation,
): Promise<PaymentValidation> {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const message = decompileTransactionMessage(compiled);

  if (compiled.version !== 'legacy') return { ok: false, reason: 'not_legacy' };
  // The compiled message is a LOSSY view (it is what `staticAccounts` + `header` +
  // `instructions` express); bytes the payer signed but that no compiled field accounts for —
  // e.g. trailing bytes after the message the kit decoder still folds into `messageBytes` —
  // would otherwise verify against a signature over MORE than what every check below inspects
  // Re-encoding and
  // comparing byte-for-byte closes that gap here too.
  if (
    !bytesEqual(
      getCompiledTransactionMessageEncoder().encode(compiled) as unknown as Uint8Array,
      transaction.messageBytes as unknown as Uint8Array,
    )
  ) {
    return { ok: false, reason: 'trailing_bytes' };
  }
  // Pins the transaction to the exact build that was issued and to its expiry.
  if (compiled.lifetimeToken !== expectation.blockhash) {
    return { ok: false, reason: 'wrong_blockhash' };
  }
  if (message.feePayer.address !== expectation.payerWallet) {
    return { ok: false, reason: 'wrong_fee_payer' };
  }

  const transfers: ReadTransfer[] = [];
  for (const instruction of message.instructions) {
    const program = instruction.programAddress;
    // ComputeBudget's own instruction contents (units, priority-fee micro-lamports) are
    // deliberately never inspected here, deliberately not just for the two instructions the builder adds but
    // for ANY ComputeBudget instruction the payer's wallet adds, including a duplicate or a
    // different unit/price. The payer is always the fee payer (checked above), so a priority
    // fee is lamports the payer alone spends on their own transaction landing faster — it can
    // never redirect USDC or change who is paid. There is nothing to validate.
    if (program === COMPUTE_BUDGET_PROGRAM_ADDRESS) continue;
    if (program !== TOKEN_PROGRAM_ADDRESS) return { ok: false, reason: 'unexpected_program' };
    const transfer = readTransfer(instruction);
    if (!transfer) return { ok: false, reason: 'unexpected_token_instruction' };
    transfers.push(transfer);
  }

  const expectedTransfers = expectation.feeAmount > 0n ? 2 : 1;
  const toRecipient = transfers.filter(
    (transfer) => transfer.destination === expectation.recipientTokenAccount,
  );
  const toFeeRecipient = transfers.filter(
    (transfer) =>
      expectation.feeRecipientTokenAccount !== null &&
      transfer.destination === expectation.feeRecipientTokenAccount,
  );
  // An extra transfer to anywhere else changes the count and is refused here.
  if (
    transfers.length !== expectedTransfers ||
    toRecipient.length !== 1 ||
    toFeeRecipient.length !== expectedTransfers - 1
  ) {
    return { ok: false, reason: 'wrong_transfer_count' };
  }

  for (const transfer of transfers) {
    if (transfer.mint !== expectation.mint || transfer.decimals !== expectation.decimals) {
      return { ok: false, reason: 'wrong_mint' };
    }
    if (
      transfer.source !== expectation.payerTokenAccount ||
      transfer.authority !== expectation.payerWallet
    ) {
      return { ok: false, reason: 'wrong_source' };
    }
  }
  if (toRecipient[0].amount !== expectation.amount) return { ok: false, reason: 'wrong_amount' };
  if (toFeeRecipient.length === 1 && toFeeRecipient[0].amount !== expectation.feeAmount) {
    return { ok: false, reason: 'wrong_amount' };
  }
  if (!toRecipient[0].extraAccounts.includes(expectation.reference)) {
    return { ok: false, reason: 'missing_reference' };
  }

  const signature = transaction.signatures[address(expectation.payerWallet)];
  if (!signature) return { ok: false, reason: 'missing_signature' };
  if (
    // verifyWalletSignature, not raw WebCrypto: it refuses a small-order or non-canonical
    // payer key, for which a signature can be forged with no private key.
    !(await verifyWalletSignature(
      expectation.payerWallet,
      // messageBytes is a branded ReadonlyUint8Array (TransactionMessageBytes); it never
      // overlaps Uint8Array's mutating methods, so tsc requires the trip through `unknown`
      // it suggests. The check only ever reads it.
      transaction.messageBytes as unknown as Uint8Array,
      signature,
    ))
  ) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true, signature: getSignatureFromTransaction(transaction) };
}
