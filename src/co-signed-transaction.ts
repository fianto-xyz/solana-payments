import {
  decompileTransactionMessage,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from '@solana/kit';
import { bytesEqual } from './bytes-equal.js';

export type CoSignFailure =
  | 'undecodable'
  | 'message_changed'
  | 'wrong_fee_payer'
  | 'wrong_signature';

export interface CoSignExpectation {
  /** The bytes the payer actually signed, before the co-signer's signature was added. */
  originalBase64: string;
  /** The fee-payer signature already validated against `originalBase64`. */
  signature: string;
  /** The wallet the caller expects as fee payer — never re-derived from the bytes being checked. */
  payerWallet: string;
}

/**
 * A check, independent of how the transaction was built, on the bytes a co-signer hands back
 * after signing. Signing may ONLY ADD a signature to what the payer already signed: it must
 * never change what was signed, never move who pays the network fee, and the signature
 * already validated must still be exactly what identifies the broadcast transaction. The
 * caller verifies all three independently, here, immediately after signing, so a bug in the
 * signing call itself — or in the caller's wiring of it — is caught structurally rather than
 * by convention.
 *
 * Three separate checks rather than one: `message_changed` proves the returned bytes are not
 * signed over a different message than the payer's own; `wrong_fee_payer` and
 * `wrong_signature` prove the caller is comparing the right two values it already holds (the
 * expected payer wallet and the signature it validated) against what the returned bytes
 * actually decode to — a caller-side wiring mistake is caught exactly like a signing bug.
 *
 * Not checked: that every OTHER required signature slot (if any) is present and valid. A
 * caller whose message declares more signers than the payer and the co-signer must check
 * that where it builds the message.
 */
export function verifyCoSignedTransaction(
  broadcastBase64: string,
  expectation: CoSignExpectation,
): { ok: true } | { ok: false; reason: CoSignFailure } {
  const decoded = decodeBoth(expectation.originalBase64, broadcastBase64);
  if (!decoded) return { ok: false, reason: 'undecodable' };
  const { original, broadcast } = decoded;

  if (
    !bytesEqual(
      original.messageBytes as unknown as Uint8Array,
      broadcast.messageBytes as unknown as Uint8Array,
    )
  ) {
    return { ok: false, reason: 'message_changed' };
  }

  const decodedMessage = decodeMessage(broadcast);
  if (!decodedMessage) return { ok: false, reason: 'undecodable' };
  if (decodedMessage.feePayer !== expectation.payerWallet) {
    return { ok: false, reason: 'wrong_fee_payer' };
  }
  if (decodedMessage.signature !== expectation.signature) {
    return { ok: false, reason: 'wrong_signature' };
  }
  return { ok: true };
}

function decodeBoth(originalBase64: string, broadcastBase64: string) {
  try {
    const decoder = getTransactionDecoder();
    const encoder = getBase64Encoder();
    return {
      original: decoder.decode(encoder.encode(originalBase64)),
      broadcast: decoder.decode(encoder.encode(broadcastBase64)),
    };
  } catch {
    return null;
  }
}

function decodeMessage(
  transaction: ReturnType<ReturnType<typeof getTransactionDecoder>['decode']>,
): { feePayer: string; signature: string } | null {
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    const message = decompileTransactionMessage(compiled);
    return {
      feePayer: message.feePayer.address,
      signature: getSignatureFromTransaction(transaction),
    };
  } catch {
    return null;
  }
}
