import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS as TOKEN_PROGRAM } from '@solana-program/token';
import {
  address,
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signTransaction,
} from '@solana/kit';
import { buildPaymentTransaction, type PaymentTransactionInput } from './payment-transaction.js';
import { verifyCoSignedTransaction } from './co-signed-transaction.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

async function keyOf(fill: number) {
  const keyPair = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(fill));
  return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
}

const ataOf = async (owner: string): Promise<string> =>
  (
    await findAssociatedTokenPda({
      owner: address(owner),
      tokenProgram: address(TOKEN_PROGRAM),
      mint: address(MINT),
    })
  )[0];

describe('verifyCoSignedTransaction', () => {
  let payer: Awaited<ReturnType<typeof keyOf>>;
  let intruder: Awaited<ReturnType<typeof keyOf>>;
  let input: PaymentTransactionInput;
  let signed: string;
  let signature: string;

  beforeAll(async () => {
    payer = await keyOf(1);
    intruder = await keyOf(9);
    const recipient = await keyOf(2);
    const feeRecipient = await keyOf(3);
    const reference = await keyOf(4);
    input = {
      payerWallet: payer.address,
      payerTokenAccount: await ataOf(payer.address),
      recipientTokenAccount: await ataOf(recipient.address),
      feeRecipientTokenAccount: await ataOf(feeRecipient.address),
      mint: MINT,
      decimals: 6,
      amount: 10_000_000n,
      feeAmount: 100_000n,
      reference: reference.address,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 350_000_000n,
      computeUnitLimit: 60_000,
      computeUnitPriceMicroLamports: 1_000n,
    };
    const built = await buildPaymentTransaction(input);
    signed = getBase64EncodedWireTransaction(
      await signTransaction(
        [payer.keyPair],
        getTransactionDecoder().decode(getBase64Encoder().encode(built.base64)),
      ),
    );
    signature = getSignatureFromTransaction(
      getTransactionDecoder().decode(getBase64Encoder().encode(signed)),
    );
  });

  it('accepts bytes unchanged from what the payer signed (no coSign, or one that adds nothing)', () => {
    expect(
      verifyCoSignedTransaction(signed, {
        originalBase64: signed,
        signature,
        payerWallet: payer.address,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses bytes whose message differs from what the payer signed', async () => {
    // A DIFFERENT transaction (different amount), also signed by the payer — simulates a
    // `coSign` that re-signed over different content instead of adding a signature to the
    // original message.
    const different = await buildPaymentTransaction({ ...input, amount: 1n });
    const differentSigned = getBase64EncodedWireTransaction(
      await signTransaction(
        [payer.keyPair],
        getTransactionDecoder().decode(getBase64Encoder().encode(different.base64)),
      ),
    );
    expect(
      verifyCoSignedTransaction(differentSigned, {
        originalBase64: signed,
        signature,
        payerWallet: payer.address,
      }),
    ).toEqual({ ok: false, reason: 'message_changed' });
  });

  it('refuses when the expected fee payer is not who the message actually names', () => {
    // The message itself is untouched (same `signed` bytes); only the EXPECTED payer wallet
    // the caller passes in is wrong — proving the comparison against the expected wallet, not just
    // the bytes, is load-bearing.
    expect(
      verifyCoSignedTransaction(signed, {
        originalBase64: signed,
        signature,
        payerWallet: intruder.address,
      }),
    ).toEqual({ ok: false, reason: 'wrong_fee_payer' });
  });

  it('refuses when the expected signature does not match what the message actually carries', () => {
    // Again the message is untouched; only the EXPECTED signature the caller already validated
    // is wrong.
    expect(
      verifyCoSignedTransaction(signed, {
        originalBase64: signed,
        signature: `${signature.slice(0, -4)}zzzz`,
        payerWallet: payer.address,
      }),
    ).toEqual({ ok: false, reason: 'wrong_signature' });
  });

  it('refuses bytes it cannot decode at all', () => {
    expect(
      verifyCoSignedTransaction('not-base64-transaction-bytes!!', {
        originalBase64: signed,
        signature,
        payerWallet: payer.address,
      }),
    ).toEqual({ ok: false, reason: 'undecodable' });
  });

  it('refuses when the ORIGINAL bytes cannot be decoded either', () => {
    expect(
      verifyCoSignedTransaction(signed, {
        originalBase64: 'also-not-base64!!',
        signature,
        payerWallet: payer.address,
      }),
    ).toEqual({ ok: false, reason: 'undecodable' });
  });
});
