import {
  address,
  createKeyPairSignerFromPrivateKeyBytes,
  decompileTransactionMessage,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  partiallySignTransaction,
} from '@solana/kit';
import {
  parseSubscriptionsInstruction,
  SubscriptionsInstruction,
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
} from '@solana/subscriptions';
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '../solana.constants.js';
import type { TransactionSigner } from '../transaction-signer.js';
import {
  buildChargeTransaction,
  ChargeBuildRefused,
  compileChargeTransaction,
  signChargeTransaction,
  type ChargeTransactionInput,
} from './charge-transaction.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RECIPIENT_ATA = '11111111111111111111111111111113';
const FEE_RECIPIENT_ATA = '11111111111111111111111111111114';
const REFERENCE = '11111111111111111111111111111115';

let puller: TransactionSigner;
let input: ChargeTransactionInput;

beforeAll(async () => {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keypair = await createKeyPairSignerFromPrivateKeyBytes(seed);
  puller = {
    address: keypair.address,
    sign: async (base64: string) =>
      getBase64EncodedWireTransaction(
        await partiallySignTransaction(
          [keypair.keyPair],
          getTransactionDecoder().decode(getBase64Encoder().encode(base64)),
        ),
      ),
  };
  input = {
    puller: puller,
    payerWallet: 'So11111111111111111111111111111111111111112',
    payerTokenAccount: 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',
    planAddress: 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse',
    subscriptionAddress: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    authorityAddress: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    mint: MINT,
    recipientTokenAccount: RECIPIENT_ATA,
    feeRecipientTokenAccount: FEE_RECIPIENT_ATA,
    amount: 10_000_000n,
    feeAmount: 500_000n,
    networkFeeAmount: 0n,
    reference: REFERENCE,
    blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
    lastValidBlockHeight: 1_000n,
    computeUnitLimit: 400_000,
    computeUnitPriceMicroLamports: 1_000n,
  };
});

function instructionsOf(base64: string) {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  return { message: decompileTransactionMessage(compiled), transaction };
}

/** The amount of each Subscriptions pull, in order (recipient, then fee recipient). */
function pullAmounts(base64: string): bigint[] {
  return instructionsOf(base64)
    .message.instructions.filter((instruction) => instruction.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS)
    .map(
      (instruction) =>
        (parseSubscriptionsInstruction(instruction as never) as never as { data: { transferData: { amount: bigint } } })
          .data.transferData.amount,
    );
}

describe('buildChargeTransaction', () => {
  it('builds exactly two pulls, to the two destinations, for the two amounts', async () => {
    const built = await buildChargeTransaction(input);
    const { message } = instructionsOf(built.base64);
    const pulls = message.instructions.filter(
      (instruction) => instruction.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS,
    );
    expect(pulls).toHaveLength(2);
    const parsed = pulls.map((instruction) => parseSubscriptionsInstruction(instruction as never));
    for (const one of parsed) {
      expect(one.instructionType).toBe(SubscriptionsInstruction.TransferSubscription);
    }
    const byDestination = new Map(
      parsed.map((one) => [
        (one as never as { accounts: { receiverAta: { address: string } } }).accounts.receiverAta.address,
        (one as never as { data: { transferData: { amount: bigint } } }).data.transferData.amount,
      ]),
    );
    expect(byDestination.get(RECIPIENT_ATA)).toBe(10_000_000n);
    expect(byDestination.get(FEE_RECIPIENT_ATA)).toBe(500_000n);
  });

  it('makes the PULLER the fee payer and the only signer', async () => {
    const built = await buildChargeTransaction(input);
    const { message, transaction } = instructionsOf(built.base64);
    expect(message.feePayer.address).toBe(puller.address);
    expect(Object.keys(transaction.signatures)).toEqual([puller.address]);
    expect(built.signature).toBe(
      // The transaction id IS the fee payer's signature.
      Object.keys(transaction.signatures)[0] === puller.address ? built.signature : 'mismatch',
    );
  });

  it('carries the reference on the FIRST pull, so the payment can be found by address', async () => {
    const built = await buildChargeTransaction(input);
    const { message } = instructionsOf(built.base64);
    const pulls = message.instructions.filter(
      (instruction) => instruction.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS,
    );
    // Ten named accounts; an eleventh is the reference.
    expect(pulls[0].accounts).toHaveLength(11);
    expect(pulls[0].accounts?.at(-1)?.address).toBe(address(REFERENCE));
    expect(pulls[1].accounts).toHaveLength(10);
  });

  it('omits the fee recipient pull entirely at a zero fee', async () => {
    const built = await buildChargeTransaction({
      ...input,
      feeAmount: 0n,
      feeRecipientTokenAccount: null,
    });
    const { message } = instructionsOf(built.base64);
    expect(
      message.instructions.filter(
        (instruction) => instruction.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS,
      ),
    ).toHaveLength(1);
  });

  it('carries exactly one compute-budget limit and one price instruction', async () => {
    const built = await buildChargeTransaction(input);
    const { message } = instructionsOf(built.base64);
    expect(
      message.instructions.filter(
        (instruction) => instruction.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS,
      ),
    ).toHaveLength(2);
  });

  it('REFUSES to build without a reference', async () => {
    // A charge with no reference cannot be matched to the payment it settles: money would
    // move with nobody credited. Fail here, loudly, at build time.
    await expect(buildChargeTransaction({ ...input, reference: '' })).rejects.toThrow(
      'must carry a reference',
    );
  });

  it('fits in one packet', async () => {
    const built = await buildChargeTransaction(input);
    expect(Buffer.from(built.base64, 'base64').length).toBeLessThan(1232);
  });

  it('REFUSES a fee with no fee recipient account, rather than silently dropping the fee pull', async () => {
    // The caller would expect a fee while the transaction pays no fee recipient at all: the
    // mismatch only shows AT FINALITY, after the recipient's share has moved. A caller bug;
    // it must be impossible to build.
    await expect(buildChargeTransaction({ ...input, feeRecipientTokenAccount: null })).rejects.toThrow(
      'fee recipient',
    );
  });

  it('pulls the fee and the network fee to the fee recipient together', async () => {
    const built = await buildChargeTransaction({ ...input, networkFeeAmount: 10_000n });
    expect(pullAmounts(built.base64)).toEqual([10_000_000n, 510_000n]);
  });

  it('pulls a network fee alone to the fee recipient at a zero fee, and refuses it without a fee recipient', async () => {
    const built = await buildChargeTransaction({ ...input, feeAmount: 0n, networkFeeAmount: 10_000n });
    expect(pullAmounts(built.base64)).toEqual([10_000_000n, 10_000n]);
    await expect(
      buildChargeTransaction({ ...input, feeAmount: 0n, networkFeeAmount: 10_000n, feeRecipientTokenAccount: null }),
    ).rejects.toThrow('fee recipient');
  });

  it('REFUSES a fee recipient account with a zero fee', async () => {
    await expect(buildChargeTransaction({ ...input, feeAmount: 0n })).rejects.toThrow('fee recipient');
  });

  it('REFUSES a signer that hands back a different message than the one it was given', async () => {
    // The signature and bytes the caller gets back must be exactly what was built: a signer —
    // a KMS, say — that re-serialised or altered the message would otherwise put a different
    // transaction on chain.
    const other = await buildChargeTransaction({ ...input, amount: 1n });
    const tampering: TransactionSigner = {
      address: puller.address,
      sign: async () => other.base64,
    };
    await expect(buildChargeTransaction({ ...input, puller: tampering })).rejects.toThrow(
      'signer changed the message',
    );
    // A typed refusal, so the caller can treat a caller/signer bug as a bug rather than a
    // transient network failure.
    await expect(
      buildChargeTransaction({ ...input, puller: tampering }),
    ).rejects.toBeInstanceOf(ChargeBuildRefused);
    await expect(
      buildChargeTransaction({ ...input, feeRecipientTokenAccount: null }),
    ).rejects.toBeInstanceOf(ChargeBuildRefused);
  });

  describe('compile, then sign', () => {
    it('compiles bytes with every signature slot empty, and never calls the signer', async () => {
      let signed = 0;
      const counting: TransactionSigner = {
        address: puller.address,
        sign: async (base64: string) => {
          signed += 1;
          return puller.sign(base64);
        },
      };
      const compiled = await compileChargeTransaction({ ...input, puller: counting });
      expect(signed).toBe(0);
      const { transaction } = instructionsOf(compiled.base64);
      expect(Object.keys(transaction.signatures)).toEqual([puller.address]);
      const slot = transaction.signatures[puller.address as keyof typeof transaction.signatures];
      expect(slot === null || (slot as Uint8Array).every((byte) => byte === 0)).toBe(true);
    });

    it('signs the very message it compiled: same bytes and signature as a one-step build', async () => {
      const compiled = await compileChargeTransaction(input);
      const built = await signChargeTransaction(compiled, puller);
      expect(built).toEqual(await buildChargeTransaction(input));
      expect(Buffer.from(instructionsOf(built.base64).transaction.messageBytes)).toEqual(
        Buffer.from(compiled.messageBytes),
      );
    });

    it('REFUSES a signer that is not the fee payer the message was compiled for', async () => {
      const other = await createKeyPairSignerFromPrivateKeyBytes(crypto.getRandomValues(new Uint8Array(32)));
      const compiled = await compileChargeTransaction({ ...input, puller: { address: other.address } });
      await expect(signChargeTransaction(compiled, puller)).rejects.toBeInstanceOf(ChargeBuildRefused);
    });
  });
});
