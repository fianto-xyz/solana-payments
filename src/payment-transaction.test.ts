import { verifyAsync as zip215VerifyAsync } from '@noble/ed25519';
import {
  AuthorityType,
  findAssociatedTokenPda,
  getApproveInstruction,
  getCloseAccountInstruction,
  getSetAuthorityInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS as TOKEN_PROGRAM,
  TRANSFER_CHECKED_DISCRIMINATOR,
} from '@solana-program/token';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairFromPrivateKeyBytes,
  createTransactionMessage,
  getAddressDecoder,
  getAddressFromPublicKey,
  getBase64Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from '@solana/kit';
import {
  buildPaymentTransaction,
  validateSignedPayment,
  type PaymentExpectation,
  type PaymentTransactionInput,
} from './payment-transaction.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
const OTHER_BLOCKHASH = '11111111111111111111111111111111';

/** Deterministic keys: the public keys of the all-n 32-byte private keys. */
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

type Msg = Parameters<typeof compileTransaction>[0];

describe('buildPaymentTransaction / validateSignedPayment', () => {
  let payer: Awaited<ReturnType<typeof keyOf>>;
  let intruder: Awaited<ReturnType<typeof keyOf>>;
  let input: PaymentTransactionInput;
  let expectation: PaymentExpectation;

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
    const { computeUnitLimit, computeUnitPriceMicroLamports, lastValidBlockHeight, ...rest } =
      input;
    void computeUnitLimit;
    void computeUnitPriceMicroLamports;
    void lastValidBlockHeight;
    expectation = rest;
  });

  const signWith = async (base64: string, keyPair: Awaited<ReturnType<typeof createKeyPairFromPrivateKeyBytes>>): Promise<string> =>
    getBase64EncodedWireTransaction(
      await signTransaction([keyPair], getTransactionDecoder().decode(getBase64Encoder().encode(base64))),
    );

  it('builds a transaction the payer can sign, and accepts it back', async () => {
    const built = await buildPaymentTransaction(input);
    expect(built.lastValidBlockHeight).toBe(350_000_000n);

    const result = await validateSignedPayment(
      await signWith(built.base64, payer.keyPair),
      expectation,
    );
    expect(result).toEqual({ ok: true, signature: expect.any(String) });
  });

  it('omits the feeRecipient transfer entirely at a zero fee', async () => {
    const free = { ...input, feeAmount: 0n, feeRecipientTokenAccount: null };
    const built = await buildPaymentTransaction(free);
    const signed = await signWith(built.base64, payer.keyPair);
    expect(
      await validateSignedPayment(signed, { ...expectation, feeAmount: 0n, feeRecipientTokenAccount: null }),
    ).toEqual({ ok: true, signature: expect.any(String) });

    // And the same bytes are NOT acceptable where a fee was expected.
    expect(await validateSignedPayment(signed, expectation)).toEqual({
      ok: false,
      reason: 'wrong_transfer_count',
    });
  });

  it('rejects an unsigned transaction', async () => {
    const built = await buildPaymentTransaction(input);
    expect(await validateSignedPayment(built.base64, expectation)).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
  });

  it('rejects a tampered signature', async () => {
    const built = await buildPaymentTransaction(input);
    const decoded = getTransactionDecoder().decode(
      getBase64Encoder().encode(await signWith(built.base64, payer.keyPair)),
    );
    const forged = new Uint8Array(decoded.signatures[address(payer.address)]!);
    forged[0] ^= 0xff;
    const tampered = getBase64Decoder().decode(
      getTransactionEncoder().encode({
        ...decoded,
        signatures: { ...decoded.signatures, [address(payer.address)]: forged },
      }),
    );
    expect(await validateSignedPayment(tampered, expectation)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a forged signature for a small-order payer key, which a permissive (ZIP215) verifier accepts', async () => {
    // The identity point (order 1) as the payer's "wallet": R = identity, S = 0 satisfies
    // [S]B == R + [h]A for every message, with no private key anywhere.
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const forgedPayer = getAddressDecoder().decode(identity);
    const forgedInput = { ...input, payerWallet: forgedPayer, payerTokenAccount: await ataOf(forgedPayer) };
    const built = await buildPaymentTransaction(forgedInput);
    const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(built.base64));
    const forged = new Uint8Array(64);
    forged[0] = 1;
    expect(
      await zip215VerifyAsync(forged, Uint8Array.from(transaction.messageBytes), identity, { zip215: true }),
    ).toBe(true);

    const signed = getBase64EncodedWireTransaction({
      ...transaction,
      signatures: { ...transaction.signatures, [address(forgedPayer)]: forged },
    } as never);
    expect(
      await validateSignedPayment(signed, {
        ...expectation,
        payerWallet: forgedPayer,
        payerTokenAccount: forgedInput.payerTokenAccount,
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects bytes appended after the compiled message that the payer signed too', async () => {
    const built = await buildPaymentTransaction(input);
    const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(built.base64));
    const trailingMessageBytes = new Uint8Array([...transaction.messageBytes, 9, 9, 9]);
    const signature = new Uint8Array(
      await crypto.subtle.sign('Ed25519', payer.keyPair.privateKey, trailingMessageBytes),
    );
    const signed = getBase64EncodedWireTransaction({
      messageBytes: trailingMessageBytes,
      signatures: { ...transaction.signatures, [address(payer.address)]: signature },
    } as never);
    expect(await validateSignedPayment(signed, expectation)).toEqual({
      ok: false,
      reason: 'trailing_bytes',
    });
  });

  it.each([
    ['undecodable', 'not base64 at all @@@'],
    ['undecodable', ''],
    ['too_large', 'A'.repeat(2_001)],
  ])('rejects junk with %s', async (reason, base64) => {
    expect(await validateSignedPayment(base64, expectation)).toEqual({ ok: false, reason });
  });

  it('rejects a transaction built on a blockhash that was never issued', async () => {
    const built = await buildPaymentTransaction({ ...input, blockhash: OTHER_BLOCKHASH });
    expect(
      await validateSignedPayment(await signWith(built.base64, payer.keyPair), expectation),
    ).toEqual({ ok: false, reason: 'wrong_blockhash' });
  });

  it.each([
    ['wrong_amount', { amount: 9_999_999n }],
    ['wrong_amount', { feeAmount: 1n }],
    ['wrong_mint', { mint: 'So11111111111111111111111111111111111111112' }],
    ['wrong_source', { payerTokenAccount: '11111111111111111111111111111111' }],
    ['wrong_transfer_count', { recipientTokenAccount: '11111111111111111111111111111111' }],
    ['missing_reference', { reference: '11111111111111111111111111111111' }],
  ] as [string, Partial<PaymentTransactionInput>][])(
    'rejects with %s when the built transaction disagrees with the expectation',
    async (reason, override) => {
      const built = await buildPaymentTransaction({ ...input, ...override });
      expect(
        await validateSignedPayment(await signWith(built.base64, payer.keyPair), expectation),
      ).toEqual({ ok: false, reason });
    },
  );

  it('rejects a transaction whose fee payer is someone else', async () => {
    const built = await buildPaymentTransaction({
      ...input,
      payerWallet: intruder.address,
    });
    expect(
      await validateSignedPayment(await signWith(built.base64, intruder.keyPair), expectation),
    ).toEqual({ ok: false, reason: 'wrong_fee_payer' });
  });

  it('rejects an instruction for any program but ComputeBudget and Token', async () => {
    // The memo program is harmless; the point is that "harmless" is not the validator's to judge.
    const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
    let message = createTransactionMessage({ version: 'legacy' as const }) as unknown as Msg;
    message = setTransactionMessageFeePayer(address(payer.address), message) as unknown as Msg;
    message = setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1n },
      message,
    ) as unknown as Msg;
    message = appendTransactionMessageInstructions(
      [getSetComputeUnitLimitInstruction({ units: 1 }), { programAddress: address(MEMO) }],
      message,
    ) as unknown as Msg;
    const base64 = getBase64EncodedWireTransaction(compileTransaction(message));
    expect(
      await validateSignedPayment(await signWith(base64, payer.keyPair), expectation),
    ).toEqual({ ok: false, reason: 'unexpected_program' });
  });

  describe('never throws, even on payer-controlled garbage', () => {
    /** A legacy message with one raw Token-program instruction, for hand-crafted payloads. */
    const withRawTokenInstruction = (data: Uint8Array, accountCount = 4): string => {
      const accounts = Array.from({ length: accountCount }, (_, index) => ({
        address: [
          input.payerTokenAccount,
          input.mint,
          input.recipientTokenAccount,
          payer.address,
        ][index % 4] as ReturnType<typeof address>,
        role: index === accountCount - 1 ? AccountRole.READONLY_SIGNER : AccountRole.WRITABLE,
      }));
      let message = createTransactionMessage({ version: 'legacy' as const }) as unknown as Msg;
      message = setTransactionMessageFeePayer(address(payer.address), message) as unknown as Msg;
      message = setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1n },
        message,
      ) as unknown as Msg;
      message = appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: 1 }),
          { programAddress: address(TOKEN_PROGRAM), accounts, data },
        ],
        message,
      ) as unknown as Msg;
      return getBase64EncodedWireTransaction(compileTransaction(message));
    };

    it('rejects transferChecked data that is too short to decode, instead of throwing', async () => {
      // discriminator only: 1 byte, not the required 10 (discriminator + u64 amount + u8 decimals).
      const base64 = withRawTokenInstruction(new Uint8Array([TRANSFER_CHECKED_DISCRIMINATOR]));
      await expect(
        validateSignedPayment(await signWith(base64, payer.keyPair), expectation),
      ).resolves.toEqual({ ok: false, reason: 'unexpected_token_instruction' });
    });

    it('rejects transferChecked data that is too long to be one, instead of throwing', async () => {
      const base64 = withRawTokenInstruction(
        new Uint8Array([TRANSFER_CHECKED_DISCRIMINATOR, ...Array.from({ length: 15 }, () => 0)]),
      );
      await expect(
        validateSignedPayment(await signWith(base64, payer.keyPair), expectation),
      ).resolves.toEqual({ ok: false, reason: 'unexpected_token_instruction' });
    });

    it('rejects a malformed stored payer wallet instead of throwing', async () => {
      const built = await buildPaymentTransaction(input);
      const signed = await signWith(built.base64, payer.keyPair);
      await expect(
        validateSignedPayment(signed, { ...expectation, payerWallet: 'not-a-real-wallet' }),
      ).resolves.toEqual({ ok: false, reason: 'wrong_fee_payer' });
    });

    it('rejects random bytes instead of throwing', async () => {
      const garbage = getBase64Decoder().decode(
        Uint8Array.from({ length: 128 }, (_, i) => (i * 37 + 11) % 256),
      );
      const result = await validateSignedPayment(garbage, expectation);
      expect(result.ok).toBe(false);
      expect(typeof (result as { reason: string }).reason).toBe('string');
    });

    it('rejects an empty string instead of throwing', async () => {
      await expect(validateSignedPayment('', expectation)).resolves.toEqual({
        ok: false,
        reason: 'undecodable',
      });
    });
  });

  describe('branches a real attack uses', () => {
    /** A legacy-shaped message, built and compiled with the given version and instructions. */
    const messageWith = (version: 'legacy' | 0, instructions: unknown[]) => {
      let message = createTransactionMessage({ version } as never) as unknown as Msg;
      message = setTransactionMessageFeePayer(address(payer.address), message) as unknown as Msg;
      message = setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1n },
        message,
      ) as unknown as Msg;
      message = appendTransactionMessageInstructions(instructions as never, message) as unknown as Msg;
      return getBase64EncodedWireTransaction(compileTransaction(message));
    };

    const recipientTransfer = (amount: bigint, reference?: string) => {
      const instruction = getTransferCheckedInstruction({
        source: address(input.payerTokenAccount),
        mint: address(input.mint),
        destination: address(input.recipientTokenAccount),
        authority: address(payer.address),
        amount,
        decimals: input.decimals,
      });
      if (!reference) return instruction;
      return {
        ...instruction,
        accounts: [
          ...instruction.accounts,
          { address: address(reference), role: AccountRole.READONLY },
        ],
      };
    };

    it('rejects a version 0 (non-legacy) transaction', async () => {
      const base64 = messageWith(0, [
        getSetComputeUnitLimitInstruction({ units: 1 }),
        recipientTransfer(input.amount, input.reference),
      ]);
      await expect(
        validateSignedPayment(await signWith(base64, payer.keyPair), expectation),
      ).resolves.toEqual({ ok: false, reason: 'not_legacy' });
    });

    it.each([
      [
        'approve',
        () =>
          getApproveInstruction({
            source: address(input.payerTokenAccount),
            delegate: address(intruder.address),
            owner: address(payer.address),
            amount: input.amount,
          }),
      ],
      [
        'setAuthority',
        () =>
          getSetAuthorityInstruction({
            owned: address(input.payerTokenAccount),
            owner: address(payer.address),
            authorityType: AuthorityType.AccountOwner,
            newAuthority: address(intruder.address),
          }),
      ],
      [
        'closeAccount',
        () =>
          getCloseAccountInstruction({
            account: address(input.payerTokenAccount),
            destination: address(intruder.address),
            owner: address(payer.address),
          }),
      ],
    ] as [string, () => unknown][])(
      // A real Token instruction that is not transferChecked. approve would hand an attacker
      // delegate authority over the payer's own token account; setAuthority and closeAccount
      // are equally destructive. None of these may ever be silently accepted alongside a
      // legitimate-looking transfer.
      'rejects a real Token "%s" instruction as unexpected_token_instruction',
      async (_name, buildInstruction) => {
        const base64 = messageWith('legacy', [
          getSetComputeUnitLimitInstruction({ units: 1 }),
          recipientTransfer(input.amount, input.reference),
          buildInstruction(),
        ]);
        expect(
          await validateSignedPayment(await signWith(base64, payer.keyPair), expectation),
        ).toEqual({ ok: false, reason: 'unexpected_token_instruction' });
      },
    );

    it('rejects a duplicate transfer to the recipient', async () => {
      const base64 = messageWith('legacy', [
        getSetComputeUnitLimitInstruction({ units: 1 }),
        recipientTransfer(input.amount, input.reference),
        recipientTransfer(input.amount),
      ]);
      expect(
        await validateSignedPayment(await signWith(base64, payer.keyPair), expectation),
      ).toEqual({ ok: false, reason: 'wrong_transfer_count' });
    });

    it('rejects an extra transfer to a third party', async () => {
      const free = { ...expectation, feeAmount: 0n, feeRecipientTokenAccount: null };
      const thirdParty = await ataOf(intruder.address);
      const toThirdParty = getTransferCheckedInstruction({
        source: address(input.payerTokenAccount),
        mint: address(input.mint),
        destination: address(thirdParty),
        authority: address(payer.address),
        amount: 1n,
        decimals: input.decimals,
      });
      const base64 = messageWith('legacy', [
        getSetComputeUnitLimitInstruction({ units: 1 }),
        recipientTransfer(input.amount, input.reference),
        toThirdParty,
      ]);
      expect(await validateSignedPayment(await signWith(base64, payer.keyPair), free)).toEqual({
        ok: false,
        reason: 'wrong_transfer_count',
      });
    });

    it('accepts an extra ComputeBudget instruction — its contents are never validated', async () => {
      // The payer is always the fee payer (checked separately), so any priority fee they set
      // is money they alone spend; a second/duplicate ComputeBudget instruction changes only
      // that, never who is paid or how much. See the comment on the instruction loop below.
      const base64 = messageWith('legacy', [
        getSetComputeUnitLimitInstruction({ units: 1 }),
        getSetComputeUnitLimitInstruction({ units: 999_999 }),
        recipientTransfer(input.amount, input.reference),
      ]);
      expect(
        await validateSignedPayment(await signWith(base64, payer.keyPair), {
          ...expectation,
          feeAmount: 0n,
          feeRecipientTokenAccount: null,
        }),
      ).toEqual({ ok: true, signature: expect.any(String) });
    });
  });
});
