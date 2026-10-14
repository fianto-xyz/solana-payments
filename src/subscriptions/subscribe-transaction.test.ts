import { verifyAsync as zip215VerifyAsync } from '@noble/ed25519';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { getTransferCheckedInstruction } from '@solana-program/token';
import {
  getTransferSubscriptionInstruction,
  identifySubscriptionsInstruction,
  parseSubscriptionsInstruction,
  SubscriptionsInstruction,
} from '@solana/subscriptions';
import {
  buildSubscribeTransaction,
  validateSignedSubscribe,
  type SubscribeExpectation,
} from './subscribe-transaction.js';
import {
  deriveEventAuthorityAddress,
  deriveSubscriptionAddress,
  deriveSubscriptionAuthorityAddress,
  derivePlanAddress,
  SUBSCRIPTIONS_PROGRAM_ID,
} from './addresses.js';
import { COMPUTE_BUDGET_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '../solana.constants.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
/** A DIFFERENT, valid blockhash — not a near-miss of the one above. */
const OTHER_BLOCKHASH = 'BXGYJLMVYsBsBTsUW5BGJjvUqrXJn8FZeNyQYD5oAnCk';

/**
 * Seven distinct, VALID addresses for the "exactly one field differs" cases. Every one is
 * real base58 of 32 bytes, because `address()` inside the validator throws on anything else
 * and the outer try/catch turns a throw into `'undecodable'` — so a malformed fixture makes
 * its case assert the wrong reason and pass for the wrong reason, which is worse than no test.
 */
const OTHER = [
  'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',
  'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse',
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'ComputeBudget111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
] as const;

/** The compiled message's instruction list, which the decoder's public type does not expose. */
type CompiledWithInstructions = { instructions: { programAddressIndex: number; accountIndices?: number[] }[] };

let payer: KeyPairSigner;
let puller: KeyPairSigner;
let owner: KeyPairSigner;
let base: SubscribeExpectation;

/** Signs as the payer, exactly as a wallet would: signTransaction, never signAndSend. */
async function payerSign(base64: string, key: KeyPairSigner = payer): Promise<string> {
  return getBase64EncodedWireTransaction(
    await partiallySignTransaction(
      [key.keyPair],
      getTransactionDecoder().decode(getBase64Encoder().encode(base64)),
    ),
  );
}

/**
 * Re-serialises an UNSIGNED built transaction with exactly one account address replaced
 * inside exactly one Subscriptions-program instruction, leaving every other instruction (and
 * every other account of that same instruction) untouched. Lets a test substitute a single
 * account — proving that account is independently asserted — without hand-building the whole
 * transaction the way `buildSubscribeTransaction` does.
 *
 * `kind`/`occurrence` pick the instruction (there are two `TransferSubscription`s when a fee
 * applies, so `occurrence` disambiguates: 0 is the recipient pull, 1 the fee recipient pull).
 * `accountIndex` is the NAMED account's position, matching the SDK's own declared order —
 * documented at each call site.
 */
function withSubstitutedAccount(
  base64: string,
  kind: SubscriptionsInstruction,
  occurrence: number,
  accountIndex: number,
  newAddress: string,
): string {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const message = decompileTransactionMessage(compiled);
  let seen = 0;
  const instructions = (message.instructions as readonly Instruction[]).map((instruction) => {
    if (
      instruction.programAddress !== SUBSCRIPTIONS_PROGRAM_ID ||
      identifySubscriptionsInstruction(instruction as unknown as { data: Uint8Array }) !== kind
    ) {
      return instruction;
    }
    const isTarget = seen === occurrence;
    seen += 1;
    if (!isTarget) return instruction;
    const accounts = instruction.accounts ?? [];
    return {
      ...instruction,
      accounts: accounts.map((meta, index) =>
        index === accountIndex ? { ...meta, address: address(newAddress) } : meta,
      ),
    };
  });
  const rebuilt = pipe(
    createTransactionMessage({ version: 'legacy' as const }),
    (current) => setTransactionMessageFeePayer(message.feePayer.address, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: compiled.lifetimeToken as never, lastValidBlockHeight: 1_000n },
        current,
      ),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  return getBase64EncodedWireTransaction(compileTransaction(rebuilt));
}

/**
 * Same shape as `withSubstitutedAccount`, but APPENDS an extra account rather than replacing
 * one — for proving an instruction's declared account COUNT is enforced. `role` defaults to
 * READONLY (an inert extra); the `subscribe`/`initSubscriptionAuthority` account-count tests
 * below also use `AccountRole.WRITABLE_SIGNER` to reproduce the exact rent-payer attack:
 * those slots are the optional RENT SPONSOR, so the puller sitting there marked writable
 * would make the co-signer's own signature pay for it.
 */
function withExtraAccount(
  base64: string,
  kind: SubscriptionsInstruction,
  occurrence: number,
  extraAddress: string,
  role: AccountRole = AccountRole.READONLY,
): string {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const message = decompileTransactionMessage(compiled);
  let seen = 0;
  const instructions = (message.instructions as readonly Instruction[]).map((instruction) => {
    if (
      instruction.programAddress !== SUBSCRIPTIONS_PROGRAM_ID ||
      identifySubscriptionsInstruction(instruction as unknown as { data: Uint8Array }) !== kind
    ) {
      return instruction;
    }
    const isTarget = seen === occurrence;
    seen += 1;
    if (!isTarget) return instruction;
    const accounts = instruction.accounts ?? [];
    return {
      ...instruction,
      accounts: [...accounts, { address: address(extraAddress), role }],
    };
  });
  const rebuilt = pipe(
    createTransactionMessage({ version: 'legacy' as const }),
    (current) => setTransactionMessageFeePayer(message.feePayer.address, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: compiled.lifetimeToken as never, lastValidBlockHeight: 1_000n },
        current,
      ),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  return getBase64EncodedWireTransaction(compileTransaction(rebuilt));
}

/**
 * The general-purpose escape hatch: decompiles an UNSIGNED built transaction, hands the
 * decompiled instruction LIST to `transform` (reorder, drop, append, mutate — anything), and
 * recompiles. Every other helper here (`withSubstitutedAccount`, `withExtraAccount`) is a
 * narrower, more readable special case of this; this one exists for the shapes those two
 * cannot express — a reordered or replaced instruction list, not just one tampered account.
 */
function withInstructions(
  base64: string,
  transform: (
    instructions: readonly Instruction[],
  ) => Parameters<typeof appendTransactionMessageInstructions>[0],
): string {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const message = decompileTransactionMessage(compiled);
  const rebuilt = pipe(
    createTransactionMessage({ version: 'legacy' as const }),
    (current) => setTransactionMessageFeePayer(message.feePayer.address, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: compiled.lifetimeToken as never, lastValidBlockHeight: 1_000n },
        current,
      ),
    (current) => appendTransactionMessageInstructions(transform(message.instructions as readonly Instruction[]), current),
  );
  return getBase64EncodedWireTransaction(compileTransaction(rebuilt));
}

/** Appends one address to the STATIC ACCOUNT LIST directly — at the compiled-message level,
 *  below `appendTransactionMessageInstructions`' abstraction — so it is referenced by NO
 *  instruction at all. This is the one shape `withInstructions` cannot produce (anything it
 *  builds is, by construction, referenced by some instruction); it is also exactly the shape
 *  an attacker would use to plant an unreferenced foreign reference. */
function withUnreferencedStaticAccount(base64: string, extraAddress: string): string {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const mutated = {
    ...compiled,
    staticAccounts: [...compiled.staticAccounts, address(extraAddress)],
    header: {
      ...compiled.header,
      // The new entry sits at the very end of the array — after every writable account and
      // every other read-only one — which is exactly where a read-only, non-signer account
      // belongs, so only this one count changes.
      numReadonlyNonSignerAccounts: compiled.header.numReadonlyNonSignerAccounts + 1,
    },
  };
  const newMessageBytes = getCompiledTransactionMessageEncoder().encode(mutated as never);
  return getBase64EncodedWireTransaction({
    ...transaction,
    messageBytes: newMessageBytes,
  } as never);
}

/** A signature that IS a real Ed25519 signature — just not one that verifies against the
 *  target transaction's own message bytes under `slotAddress`'s public key. `signer` signs a
 *  throwaway decoy transaction (a different fee payer, or the same payer over different
 *  bytes — the caller picks which), and the resulting signature is returned raw, ready to be
 *  spliced into a different transaction's signature slot by `withSignatureAt`. */
async function decoySignature(feePayerAddress: string, signer: KeyPairSigner): Promise<Uint8Array> {
  const decoyUnsigned = getBase64EncodedWireTransaction(
    compileTransaction(
      pipe(
        createTransactionMessage({ version: 'legacy' as const }),
        (m) => setTransactionMessageFeePayer(address(feePayerAddress), m),
        (m) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: OTHER_BLOCKHASH as never, lastValidBlockHeight: 1_000n },
            m,
          ),
        (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: 1 })], m),
      ),
    ),
  );
  const decoySigned = await payerSign(decoyUnsigned, signer);
  const decoyTransaction = getTransactionDecoder().decode(getBase64Encoder().encode(decoySigned));
  const signature = decoyTransaction.signatures[address(feePayerAddress)];
  if (!signature) throw new Error('decoySignature: decoy signing produced no signature');
  return signature as Uint8Array;
}

/** Splices a raw signature into an already-signed (or unsigned) transaction's slot for
 *  `slotAddress`, leaving every other signature untouched. */
function withSignatureAt(base64: string, slotAddress: string, signature: Uint8Array): string {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  return getBase64EncodedWireTransaction({
    ...transaction,
    signatures: { ...transaction.signatures, [address(slotAddress)]: signature },
  } as never);
}

/**
 * Inserts a THIRD signer requirement — a brand new address nothing in the message ever
 * actually signs for — at the compiled-message level, and shifts every instruction's
 * account-index references (`programAddressIndex`, `accountIndices`) that pointed past the
 * insertion point, so the message stays internally consistent: every instruction still
 * resolves to the SAME accounts it did before, just at one higher index where the insertion
 * pushed them. This is the one shape none of `withInstructions`/`withExtraAccount` can
 * produce: an extra signer that is not attached to any instruction's own account list at all.
 */
function withExtraUnfilledSigner(base64: string, extraAddress: string): string {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const insertAt = compiled.header.numSignerAccounts;
  const shift = (index: number) => (index >= insertAt ? index + 1 : index);
  const mutated = {
    ...compiled,
    staticAccounts: [
      ...compiled.staticAccounts.slice(0, insertAt),
      address(extraAddress),
      ...compiled.staticAccounts.slice(insertAt),
    ],
    instructions: (compiled as unknown as CompiledWithInstructions).instructions.map((instruction) => ({
      ...instruction,
      programAddressIndex: shift(instruction.programAddressIndex),
      accountIndices: instruction.accountIndices?.map(shift),
    })),
    header: {
      ...compiled.header,
      numSignerAccounts: compiled.header.numSignerAccounts + 1,
      numReadonlySignerAccounts: compiled.header.numReadonlySignerAccounts + 1,
    },
  };
  const newMessageBytes = getCompiledTransactionMessageEncoder().encode(mutated as never);
  return getBase64EncodedWireTransaction({
    messageBytes: newMessageBytes,
    signatures: { ...transaction.signatures, [address(extraAddress)]: null },
  } as never);
}

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  puller = await generateKeyPairSigner();
  owner = await generateKeyPairSigner();
  const plan = await derivePlanAddress(owner.address, 42n);
  const authority = await deriveSubscriptionAuthorityAddress(payer.address, MINT);
  const subscription = await deriveSubscriptionAddress(plan.address, payer.address);
  base = {
    payerWallet: payer.address,
    // Real base58 of 32 bytes. Not a token account on any cluster — the validator compares
    // addresses, it never resolves them — but it must PARSE.
    payerTokenAccount: 'So11111111111111111111111111111111111111112',
    planOwner: owner.address,
    planAddress: plan.address,
    planBump: plan.bump,
    planId: 42n,
    subscriptionAddress: subscription.address,
    authorityAddress: authority.address,
    authorityInitId: 7n,
    authorityExists: true,
    mint: MINT,
    decimals: 6,
    capAmount: 10_500_000n,
    periodHours: 720,
    termsCreatedAt: 1_700_000_000n,
    amount: 10_000_000n,
    feeAmount: 500_000n,
    networkFeeAmount: 0n,
    recipientTokenAccount: '11111111111111111111111111111113',
    feeRecipientTokenAccount: '11111111111111111111111111111114',
    reference: '11111111111111111111111111111115',
    blockhash: BLOCKHASH,
    puller: puller.address,
  };
});

const build = (overrides: Partial<SubscribeExpectation> = {}) =>
  buildSubscribeTransaction({
    ...base,
    ...overrides,
    computeUnitLimit: 400_000,
    computeUnitPriceMicroLamports: 1_000n,
    lastValidBlockHeight: 1_000n,
  });

describe('buildSubscribeTransaction', () => {
  it('fits in one packet in the worst case: new authority, non-zero fee', async () => {
    const built = await build({ authorityExists: false });
    expect(Buffer.from(built.base64, 'base64').length).toBeLessThan(1232);
  });

  it('omits initSubscriptionAuthority for a wallet that already has one', async () => {
    const withInit = await build({ authorityExists: false });
    const withoutInit = await build({ authorityExists: true });
    expect(Buffer.from(withoutInit.base64, 'base64').length).toBeLessThan(
      Buffer.from(withInit.base64, 'base64').length,
    );
    await expect(validateSignedSubscribe(await payerSign(withoutInit.base64), base)).resolves.toMatchObject({ ok: true });
  });

  it('refuses a first charge above the cap, or of nothing (a discounted charge sits under it)', async () => {
    const opts = { computeUnitLimit: 40_000, computeUnitPriceMicroLamports: 1n, lastValidBlockHeight: 1n };
    await expect(buildSubscribeTransaction({ ...base, networkFeeAmount: 10_000n, ...opts })).rejects.toThrow('cap');
    await expect(buildSubscribeTransaction({ ...base, networkFeeAmount: 1n, ...opts })).rejects.toThrow('cap');
    await expect(buildSubscribeTransaction({ ...base, amount: 0n, feeAmount: 0n, ...opts })).rejects.toThrow('cap');
    await expect(buildSubscribeTransaction({ ...base, networkFeeAmount: 10_000n, capAmount: 10_510_000n, ...opts })).resolves.toBeDefined();
    // Exactly the cap (every undiscounted subscribe) and one unit under it both build.
    await expect(buildSubscribeTransaction({ ...base, ...opts })).resolves.toBeDefined();
    await expect(buildSubscribeTransaction({ ...base, feeAmount: 499_999n, ...opts })).resolves.toBeDefined();
  });

  it('omits the fee recipient pull entirely at a zero fee', async () => {
    const zero = { ...base, feeAmount: 0n, capAmount: 10_000_000n, feeRecipientTokenAccount: null };
    const built = await buildSubscribeTransaction({
      ...zero,
      computeUnitLimit: 400_000,
      computeUnitPriceMicroLamports: 1_000n,
      lastValidBlockHeight: 1_000n,
    });
    await expect(validateSignedSubscribe(await payerSign(built.base64), zero)).resolves.toMatchObject({ ok: true });
  });
});

describe('validateSignedSubscribe — the happy path', () => {
  it('accepts exactly what was built, signed by the payer', async () => {
    const built = await build({ authorityExists: false });
    const result = await validateSignedSubscribe(
      await payerSign(built.base64),
      { ...base, authorityExists: false },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{60,100}$/);
  });
});

describe('validateSignedSubscribe — every way it can differ', () => {
  it.each([
    ['a different plan', { planAddress: OTHER[0] }, 'wrong_plan'],
    ['a different cap', { capAmount: 10_600_000n }, 'wrong_terms'],
    ['a different period', { periodHours: 8760 }, 'wrong_terms'],
    ['a different created_at', { termsCreatedAt: 1_700_000_001n }, 'wrong_terms'],
    ['a different authority init id', { authorityInitId: 8n }, 'wrong_terms'],
    ['a different mint', { mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' }, 'wrong_terms'],
    ['a different subscription pda', { subscriptionAddress: OTHER[1] }, 'wrong_subscription'],
    ['a different authority pda', { authorityAddress: OTHER[2] }, 'wrong_authority'],
    ['a different recipient destination', { recipientTokenAccount: OTHER[3] }, 'wrong_destination'],
    ['a different fee recipient destination', { feeRecipientTokenAccount: OTHER[4] }, 'wrong_destination'],
    ['a different price', { amount: 9_999_999n }, 'wrong_amount'],
    ['a different fee', { feeAmount: 499_999n }, 'wrong_amount'],
    ['a different reference', { reference: OTHER[5] }, 'missing_reference'],
    ['a different blockhash', { blockhash: OTHER_BLOCKHASH }, 'wrong_blockhash'],
    ['a different puller', { puller: OTHER[6] }, 'wrong_caller'],
    ['a different payer token account', { payerTokenAccount: OTHER[0] }, 'wrong_delegator'],
  ])('refuses %s', async (_label, difference, reason) => {
    // Built with the TRUE values, checked against an expectation that differs by one field:
    // the same thing as a payer returning a transaction that is not the one that was prepared.
    const built = await build();
    const result = await validateSignedSubscribe(await payerSign(built.base64), {
      ...base,
      ...(difference as Partial<SubscribeExpectation>),
    });
    expect(result).toEqual({ ok: false, reason });
  });

  it('refuses an initSubscriptionAuthority that was not asked for', async () => {
    const built = await build({ authorityExists: false });
    const result = await validateSignedSubscribe(await payerSign(built.base64), {
      ...base,
      authorityExists: true,
    });
    expect(result).toEqual({ ok: false, reason: 'unexpected_authority_init' });
  });

  it('refuses a missing initSubscriptionAuthority when the wallet has none', async () => {
    const built = await build({ authorityExists: true });
    const result = await validateSignedSubscribe(await payerSign(built.base64), {
      ...base,
      authorityExists: false,
    });
    expect(result).toEqual({ ok: false, reason: 'missing_authority_init' });
  });

  it('never lets a malformed address in a fixture masquerade as a real refusal', async () => {
    // Guards the guard: if a case above used a string that is not base58 of 32 bytes,
    // `address()` would throw inside the validator and every such case would report
    // 'undecodable' while claiming to test a specific field.
    const built = await build();
    const signed = await payerSign(built.base64);
    for (const candidate of OTHER) {
      const result = await validateSignedSubscribe(signed, { ...base, planAddress: candidate });
      expect(result).toEqual({ ok: false, reason: 'wrong_plan' });
    }
  });

  it('refuses an extra token-program transfer smuggled in beside the pulls', async () => {
    const built = await build();
    const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(built.base64));
    // Re-compile with one extra transferChecked: the wallet may re-serialise, so the gate
    // compares MEANING, and an extra instruction changes the meaning.
    const smuggled = pipe(
      createTransactionMessage({ version: 'legacy' as const }),
      (message) => setTransactionMessageFeePayer(address(base.payerWallet), message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_000n },
          message,
        ),
      (message) =>
        appendTransactionMessageInstructions(
          [
            getSetComputeUnitLimitInstruction({ units: 400_000 }),
            getTransferCheckedInstruction({
              source: address(base.payerTokenAccount),
              mint: address(MINT),
              destination: address('11111111111111111111111111111119'),
              authority: address(base.payerWallet),
              amount: 1n,
              decimals: 6,
            }),
          ],
          message,
        ),
    );
    const signed = await payerSign(getBase64EncodedWireTransaction(compileTransaction(smuggled)));
    const result = await validateSignedSubscribe(signed, base);
    expect(result).toEqual({ ok: false, reason: 'unexpected_program' });
    void transaction;
  });

  it('refuses a transaction the payer never signed', async () => {
    const built = await build();
    await expect(validateSignedSubscribe(built.base64, base)).resolves.toEqual({
      ok: false,
      reason: 'missing_signature',
    });
  });

  it('refuses a forged signature for a small-order payer key, which a permissive (ZIP215) verifier accepts', async () => {
    // The identity point (order 1) as the payer's "wallet": R = identity, S = 0 satisfies
    // [S]B == R + [h]A for every message, with no private key anywhere.
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const forgedPayer = getAddressDecoder().decode(identity);
    const expectation: SubscribeExpectation = {
      ...base,
      payerWallet: forgedPayer,
      authorityAddress: (await deriveSubscriptionAuthorityAddress(forgedPayer, MINT)).address,
      subscriptionAddress: (await deriveSubscriptionAddress(base.planAddress, forgedPayer)).address,
    };
    const built = await build(expectation);
    const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(built.base64));
    const forged = new Uint8Array(64);
    forged[0] = 1;
    expect(
      await zip215VerifyAsync(forged, Uint8Array.from(transaction.messageBytes), identity, { zip215: true }),
    ).toBe(true);

    await expect(
      validateSignedSubscribe(withSignatureAt(built.base64, forgedPayer, forged), expectation),
    ).resolves.toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a transaction whose fee payer is somebody else', async () => {
    const other = await generateKeyPairSigner();
    const built = await build({ payerWallet: other.address });
    await expect(validateSignedSubscribe(await payerSign(built.base64, other), base)).resolves.toEqual(
      { ok: false, reason: 'wrong_fee_payer' },
    );
  });

  it.each([
    ['garbage', 'not base64 at all!!'],
    ['an empty string', ''],
    ['something far too long', 'A'.repeat(3_000)],
  ])('never throws on %s', async (_label, input) => {
    const result = await validateSignedSubscribe(input, base);
    expect(result.ok).toBe(false);
  });
});

describe('validateSignedSubscribe — every account, not just the ones with test-table entries', () => {
  // initSubscriptionAuthority's named accounts, in the SDK's own declared order:
  // owner(0), subscriptionAuthority(1), tokenMint(2), userAta(3), systemProgram(4), tokenProgram(5).
  it('refuses a userAta that differs from the payer token account', async () => {
    const built = await build({ authorityExists: false });
    const tampered = withSubstitutedAccount(
      built.base64,
      SubscriptionsInstruction.InitSubscriptionAuthority,
      0,
      3,
      OTHER[0],
    );
    const result = await validateSignedSubscribe(await payerSign(tampered), {
      ...base,
      authorityExists: false,
    });
    expect(result).toEqual({ ok: false, reason: 'wrong_delegator' });
  });

  it('refuses an initSubscriptionAuthority with an extra (sponsor-payer) account', async () => {
    const built = await build({ authorityExists: false });
    const tampered = withExtraAccount(
      built.base64,
      SubscriptionsInstruction.InitSubscriptionAuthority,
      0,
      OTHER[0],
    );
    const result = await validateSignedSubscribe(await payerSign(tampered), {
      ...base,
      authorityExists: false,
    });
    expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
  });

  it('refuses a substituted system program on initSubscriptionAuthority', async () => {
    const built = await build({ authorityExists: false });
    const tampered = withSubstitutedAccount(
      built.base64,
      SubscriptionsInstruction.InitSubscriptionAuthority,
      0,
      4,
      OTHER[0],
    );
    const result = await validateSignedSubscribe(await payerSign(tampered), {
      ...base,
      authorityExists: false,
    });
    expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
  });

  it('refuses a substituted token program on initSubscriptionAuthority', async () => {
    const built = await build({ authorityExists: false });
    const tampered = withSubstitutedAccount(
      built.base64,
      SubscriptionsInstruction.InitSubscriptionAuthority,
      0,
      5,
      OTHER[0],
    );
    const result = await validateSignedSubscribe(await payerSign(tampered), {
      ...base,
      authorityExists: false,
    });
    expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
  });

  // subscribe's named accounts, in the SDK's own declared order: subscriber(0), `merchant`(1),
  // planPda(2), subscriptionPda(3), subscriptionAuthorityPda(4), systemProgram(5),
  // eventAuthority(6), selfProgram(7).
  it('refuses a substituted system program on subscribe', async () => {
    const built = await build();
    const tampered = withSubstitutedAccount(built.base64, SubscriptionsInstruction.Subscribe, 0, 5, OTHER[0]);
    const result = await validateSignedSubscribe(await payerSign(tampered), base);
    expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
  });

  it('refuses a substituted event authority on subscribe', async () => {
    const built = await build();
    const tampered = withSubstitutedAccount(built.base64, SubscriptionsInstruction.Subscribe, 0, 6, OTHER[0]);
    const result = await validateSignedSubscribe(await payerSign(tampered), base);
    expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
  });

  it('refuses a substituted self program on subscribe', async () => {
    const built = await build();
    const tampered = withSubstitutedAccount(built.base64, SubscriptionsInstruction.Subscribe, 0, 7, OTHER[0]);
    const result = await validateSignedSubscribe(await payerSign(tampered), base);
    expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
  });

  it("refuses a wrong subscribe-instruction authority PDA even when both pulls are correct — proving subscribe's own check is not dead weight behind the pulls' identical one", async () => {
    // Both pulls reference the REAL authority (base.authorityAddress); only `subscribe`'s own
    // subscriptionAuthorityPda account is tampered with. If subscribe's own assertion were
    // ever deleted, this specific case — unlike "a different authority pda" in the main table,
    // which tampers the EXPECTATION and so is also caught by the pulls' identical check —
    // would slip through, because the pulls in the actual bytes are untouched and correct.
    const built = await build();
    const tampered = withSubstitutedAccount(
      built.base64,
      SubscriptionsInstruction.Subscribe,
      0,
      4,
      OTHER[0],
    );
    const result = await validateSignedSubscribe(await payerSign(tampered), base);
    expect(result).toEqual({ ok: false, reason: 'wrong_authority' });
  });
});

describe("validateSignedSubscribe — the pulls' own program-identity accounts (the puller's own signature is on these)", () => {
  // transferSubscription's named accounts, in the SDK's own declared order: subscriptionPda(0),
  // planPda(1), subscriptionAuthority(2), delegatorAta(3), receiverAta(4), caller(5),
  // tokenMint(6), tokenProgram(7), eventAuthority(8), selfProgram(9). `base`'s feeAmount > 0 and
  // feeRecipientTokenAccount is set, so `build()` always produces TWO TransferSubscription
  // instructions: occurrence 0 is the recipient pull, occurrence 1 the fee recipient pull — tested
  // separately, since both are instructions the puller signs and either could be tampered
  // independently of the other.
  it.each([
    ['the recipient pull', 0],
    ['the fee recipient pull', 1],
  ])('refuses a substituted token program on %s', async (_label, occurrence) => {
    const built = await build();
    const tampered = withSubstitutedAccount(
      built.base64,
      SubscriptionsInstruction.TransferSubscription,
      occurrence as number,
      7,
      OTHER[0],
    );
    const result = await validateSignedSubscribe(await payerSign(tampered), base);
    expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
  });

  it.each([
    ['the recipient pull', 0],
    ['the fee recipient pull', 1],
  ])('refuses a substituted event authority on %s', async (_label, occurrence) => {
    const built = await build();
    const tampered = withSubstitutedAccount(
      built.base64,
      SubscriptionsInstruction.TransferSubscription,
      occurrence as number,
      8,
      OTHER[0],
    );
    const result = await validateSignedSubscribe(await payerSign(tampered), base);
    expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
  });

  it.each([
    ['the recipient pull', 0],
    ['the fee recipient pull', 1],
  ])('refuses a substituted self program on %s', async (_label, occurrence) => {
    const built = await build();
    const tampered = withSubstitutedAccount(
      built.base64,
      SubscriptionsInstruction.TransferSubscription,
      occurrence as number,
      9,
      OTHER[0],
    );
    const result = await validateSignedSubscribe(await payerSign(tampered), base);
    expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
  });

  it.each([
    ['the recipient pull', 0],
    ['the fee recipient pull', 1],
  ])('refuses an extra account smuggled onto %s beyond the one reference the builder ever adds', async (_label, occurrence) => {
    const built = await build();
    const tampered = withExtraAccount(
      built.base64,
      SubscriptionsInstruction.TransferSubscription,
      occurrence as number,
      OTHER[0],
    );
    const result = await validateSignedSubscribe(await payerSign(tampered), base);
    expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
  });
});

describe('validateSignedSubscribe — binding the whole message', () => {
  describe('ComputeBudget: any number, zero accounts, a known kind, exact data length', () => {
    it('accepts a transaction with no ComputeBudget instruction at all', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) =>
        ix.filter((instr) => instr.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toMatchObject({ ok: true });
    });

    it('accepts an extra legitimate ComputeBudget instruction the payer prepends', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) => [
        getSetComputeUnitPriceInstruction({ microLamports: 5_000n }),
        ...ix,
      ]);
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toMatchObject({ ok: true });
    });

    it('refuses a ComputeBudget instruction carrying an account (e.g. another payment\'s reference)', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) =>
        ix.map((instr, i) =>
          i === 0
            ? { ...instr, accounts: [{ address: address(base.reference), role: AccountRole.READONLY }] }
            : instr,
        ),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
    });

    it('refuses a ComputeBudget instruction carrying the puller as a writable signer', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) =>
        ix.map((instr, i) =>
          i === 0
            ? {
                ...instr,
                accounts: [{ address: address(puller.address), role: AccountRole.WRITABLE_SIGNER }],
              }
            : instr,
        ),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
    });

    it('refuses a ComputeBudget instruction with an unknown discriminator', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) =>
        ix.map((instr, i) => (i === 0 ? { ...instr, data: new Uint8Array([250]) } : instr)),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
    });

    it('refuses a ComputeBudget instruction with trailing data', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) =>
        ix.map((instr, i) =>
          i === 0
            ? { ...instr, data: new Uint8Array([...(instr.data as Uint8Array), 0]) }
            : instr,
        ),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
    });

    it('refuses ComputeBudget instructions moved after subscribe — order is fixed, not just presence', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) => {
        const cb = ix.filter((instr) => instr.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS);
        const rest = ix.filter((instr) => instr.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS);
        return [...rest, ...cb];
      });
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result.ok).toBe(false);
    });
  });

  describe('exact instruction data length (trailing data refused) on every other instruction', () => {
    it('refuses trailing data on subscribe', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) =>
        ix.map((instr) => {
          if (instr.programAddress !== SUBSCRIPTIONS_PROGRAM_ID) return instr;
          if (identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) !== SubscriptionsInstruction.Subscribe) {
            return instr;
          }
          return { ...instr, data: new Uint8Array([...(instr.data as Uint8Array), 0]) };
        }),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
    });

    it('refuses trailing data on initSubscriptionAuthority', async () => {
      const built = await build({ authorityExists: false });
      const tampered = withInstructions(built.base64, (ix) =>
        ix.map((instr) => {
          if (instr.programAddress !== SUBSCRIPTIONS_PROGRAM_ID) return instr;
          if (
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) !==
            SubscriptionsInstruction.InitSubscriptionAuthority
          ) {
            return instr;
          }
          return { ...instr, data: new Uint8Array([...(instr.data as Uint8Array), 0]) };
        }),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), {
        ...base,
        authorityExists: false,
      });
      expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
    });

    it('refuses trailing data on a pull', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) =>
        ix.map((instr) => {
          if (instr.programAddress !== SUBSCRIPTIONS_PROGRAM_ID) return instr;
          if (
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) !==
            SubscriptionsInstruction.TransferSubscription
          ) {
            return instr;
          }
          return { ...instr, data: new Uint8Array([...(instr.data as Uint8Array), 0]) };
        }),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
    });
  });

  describe('the static account list is exactly the union of what the accepted instructions reference', () => {
    it("refuses an unreferenced static account riding along (e.g. another payment's reference)", async () => {
      const built = await build();
      const tampered = withUnreferencedStaticAccount(built.base64, OTHER[0]);
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_accounts' });
    });
  });

  describe('the writable set is exactly what the builder builds', () => {
    /** Re-marks one account of every TransferSubscription (0 subscription, 1 plan, 2 authority,
     *  3 delegator ATA, 4 receiver ATA, 5 caller, 6 mint, …). */
    const remark = (index: number, role: AccountRole) => async () => {
      const built = await build();
      return withInstructions(built.base64, (ix) =>
        ix.map((instr) => {
          if (instr.programAddress !== SUBSCRIPTIONS_PROGRAM_ID) return instr;
          if (
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) !==
            SubscriptionsInstruction.TransferSubscription
          ) {
            return instr;
          }
          const accounts = instr.accounts ?? [];
          return { ...instr, accounts: accounts.map((meta, i) => (i === index ? { ...meta, role } : meta)) };
        }),
      );
    };

    it('refuses a receiving token account demoted to read-only', async () => {
      const tampered = await remark(4, AccountRole.READONLY)();
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_accounts' });
    });

    it('refuses the mint promoted to writable', async () => {
      const tampered = await remark(6, AccountRole.WRITABLE)();
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_accounts' });
    });
  });

  describe('the signer set is exactly {payer, puller}, puller read-only', () => {
    it('refuses the puller demoted to a non-signer', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) =>
        ix.map((instr) => {
          if (instr.programAddress !== SUBSCRIPTIONS_PROGRAM_ID) return instr;
          if (
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) !==
            SubscriptionsInstruction.TransferSubscription
          ) {
            return instr;
          }
          const accounts = instr.accounts ?? [];
          return {
            ...instr,
            accounts: accounts.map((meta, i) => (i === 5 ? { ...meta, role: AccountRole.READONLY } : meta)),
          };
        }),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_signers' });
    });

    it("refuses the puller promoted to writable — the flag that costs nothing on chain today only because\n       nothing it signs reaches a System Program CPI, which is not a flag to grant just because it is harmless", async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) =>
        ix.map((instr) => {
          if (instr.programAddress !== SUBSCRIPTIONS_PROGRAM_ID) return instr;
          if (
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) !==
            SubscriptionsInstruction.TransferSubscription
          ) {
            return instr;
          }
          const accounts = instr.accounts ?? [];
          return {
            ...instr,
            accounts: accounts.map((meta, i) =>
              i === 5 ? { ...meta, role: AccountRole.WRITABLE_SIGNER } : meta,
            ),
          };
        }),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_signers' });
    });

    it('refuses an extra, unfilled signer slot', async () => {
      // A BRAND NEW address is, by construction, also not in `expectedStaticAccounts` — so
      // this specific construction is caught by the static-account-set check first, not the
      // signer-set check (both independently close this attack; the demoted/promoted-to-
      // writable cases above are what isolate `numSignerAccounts`/`numReadonlySignerAccounts`
      // on their own, since they change no address, only a role, so the account SET is
      // unchanged and the static-account check passes through to this one).
      const built = await build();
      const stranger = await generateKeyPairSigner();
      const tampered = withExtraUnfilledSigner(built.base64, stranger.address);
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_accounts' });
    });
  });
});

describe('validateSignedSubscribe — the payer signature is load-bearing', () => {
  it("refuses a stranger's signature placed in the payer's slot", async () => {
    const built = await build();
    const stranger = await generateKeyPairSigner();
    const forged = await decoySignature(stranger.address, stranger);
    const tampered = withSignatureAt(built.base64, base.payerWallet, forged);
    const result = await validateSignedSubscribe(tampered, base);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a valid payer signature produced over a different message', async () => {
    const built = await build();
    const forged = await decoySignature(base.payerWallet, payer);
    const tampered = withSignatureAt(built.base64, base.payerWallet, forged);
    const result = await validateSignedSubscribe(tampered, base);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('validateSignedSubscribe — trailing signed bytes', () => {
  it('refuses bytes appended after the compiled message that the payer signed too', async () => {
    const unsigned = await build();
    const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(unsigned.base64));
    const trailingMessageBytes = new Uint8Array([...transaction.messageBytes, 9, 9, 9]);
    const signature = new Uint8Array(
      await crypto.subtle.sign('Ed25519', payer.keyPair.privateKey, trailingMessageBytes),
    );
    const signed = getBase64EncodedWireTransaction({
      messageBytes: trailingMessageBytes,
      signatures: { ...transaction.signatures, [address(payer.address)]: signature },
    } as never);
    const result = await validateSignedSubscribe(signed, base);
    expect(result).toEqual({ ok: false, reason: 'trailing_bytes' });
  });
});

describe('validateSignedSubscribe — the rent-payer account counts precisely', () => {
  it(
    "refuses subscribe carrying the puller as a writable 9th (rent-payer) account — the " +
      "exact attack that would drain the co-signer's SOL",
    async () => {
      const built = await build();
      const tampered = withExtraAccount(
        built.base64,
        SubscriptionsInstruction.Subscribe,
        0,
        puller.address,
        AccountRole.WRITABLE_SIGNER,
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
    },
  );

  it('refuses initSubscriptionAuthority carrying the puller as a writable 7th (rent-payer) account', async () => {
    const built = await build({ authorityExists: false });
    const tampered = withExtraAccount(
      built.base64,
      SubscriptionsInstruction.InitSubscriptionAuthority,
      0,
      puller.address,
      AccountRole.WRITABLE_SIGNER,
    );
    const result = await validateSignedSubscribe(await payerSign(tampered), {
      ...base,
      authorityExists: false,
    });
    expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
  });
});

describe('validateSignedSubscribe — the pull count is load-bearing', () => {
  it('refuses a third pull to an arbitrary destination after the expected two', async () => {
    const built = await build();
    const extraPull = getTransferSubscriptionInstruction({
      subscriptionPda: address(base.subscriptionAddress),
      planPda: address(base.planAddress),
      subscriptionAuthority: address(base.authorityAddress),
      delegatorAta: address(base.payerTokenAccount),
      receiverAta: address(OTHER[0]),
      caller: createNoopSigner(address(puller.address)),
      tokenMint: address(MINT),
      tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
      eventAuthority: address(await deriveEventAuthorityAddress()),
      transferData: { amount: 1n, delegator: address(base.payerWallet), mint: address(MINT) },
    });
    const tampered = withInstructions(built.base64, (ix) => [...ix, extraPull]);
    const result = await validateSignedSubscribe(await payerSign(tampered), base);
    expect(result).toEqual({ ok: false, reason: 'unexpected_instruction' });
  });
});

describe('validateSignedSubscribe — mechanical mutation-coverage gaps', () => {
  it('refuses a base64 string over the size limit with the SPECIFIC too_large reason', async () => {
    // The existing "never throws on ... something far too long" case only checks `.ok`, so it
    // stays green even if `too_large` itself is deleted (the oversized garbage then fails
    // structurally instead, as `undecodable`) — this one pins the EXACT reason.
    const result = await validateSignedSubscribe('A'.repeat(2_001), base);
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses a v0 message (not_legacy)', async () => {
    const eventAuthority = await deriveEventAuthorityAddress();
    const v0Message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(address(base.payerWallet), m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_000n },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getSetComputeUnitLimitInstruction({ units: 400_000 }),
            getTransferSubscriptionInstruction({
              subscriptionPda: address(base.subscriptionAddress),
              planPda: address(base.planAddress),
              subscriptionAuthority: address(base.authorityAddress),
              delegatorAta: address(base.payerTokenAccount),
              receiverAta: address(base.recipientTokenAccount),
              caller: createNoopSigner(address(puller.address)),
              tokenMint: address(MINT),
              tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
              eventAuthority: address(eventAuthority),
              transferData: { amount: base.amount, delegator: address(base.payerWallet), mint: address(MINT) },
            }),
          ],
          m,
        ),
    );
    const v0Base64 = getBase64EncodedWireTransaction(compileTransaction(v0Message));
    const result = await validateSignedSubscribe(await payerSign(v0Base64), base);
    expect(result).toEqual({ ok: false, reason: 'not_legacy' });
  });

  describe('initSubscriptionAuthority accounts untested by the field-difference table (authorityExists:true skips it there)', () => {
    it('refuses a substituted owner', async () => {
      const built = await build({ authorityExists: false });
      const tampered = withSubstitutedAccount(
        built.base64,
        SubscriptionsInstruction.InitSubscriptionAuthority,
        0,
        0,
        OTHER[0],
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), {
        ...base,
        authorityExists: false,
      });
      expect(result).toEqual({ ok: false, reason: 'wrong_delegator' });
    });

    it('refuses a substituted subscriptionAuthority — isolated from subscribe\'s and the pulls\' identical copies', async () => {
      const built = await build({ authorityExists: false });
      const tampered = withSubstitutedAccount(
        built.base64,
        SubscriptionsInstruction.InitSubscriptionAuthority,
        0,
        1,
        OTHER[0],
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), {
        ...base,
        authorityExists: false,
      });
      expect(result).toEqual({ ok: false, reason: 'wrong_authority' });
    });

    it('refuses a substituted tokenMint — isolated from subscribeData\'s and the pulls\' identical copies', async () => {
      const built = await build({ authorityExists: false });
      const tampered = withSubstitutedAccount(
        built.base64,
        SubscriptionsInstruction.InitSubscriptionAuthority,
        0,
        2,
        OTHER[2],
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), {
        ...base,
        authorityExists: false,
      });
      expect(result).toEqual({ ok: false, reason: 'wrong_terms' });
    });
  });

  describe('subscribe accounts untested by the field-difference table (masked by the pulls\' identical copies)', () => {
    it('refuses a substituted subscriber', async () => {
      const built = await build();
      const tampered = withSubstitutedAccount(built.base64, SubscriptionsInstruction.Subscribe, 0, 0, OTHER[0]);
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_delegator' });
    });

    it('refuses a substituted plan owner (the `merchant` account)', async () => {
      const built = await build();
      const tampered = withSubstitutedAccount(built.base64, SubscriptionsInstruction.Subscribe, 0, 1, OTHER[0]);
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_delegator' });
    });

    it("refuses a substituted subscriptionPda on subscribe — isolated from the pulls' identical copy", async () => {
      const built = await build();
      const tampered = withSubstitutedAccount(built.base64, SubscriptionsInstruction.Subscribe, 0, 3, OTHER[0]);
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_subscription' });
    });
  });

  describe('pull accounts masked by subscribe\'s or the other pull\'s identical copy', () => {
    it("refuses a substituted subscriptionPda/planPda on the recipient pull — isolated from subscribe's own copy", async () => {
      const built = await build();
      const tampered = withSubstitutedAccount(
        built.base64,
        SubscriptionsInstruction.TransferSubscription,
        0,
        0,
        OTHER[0],
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_subscription' });
    });

    it("refuses a substituted subscriptionAuthority on the recipient pull — isolated from subscribe's own copy", async () => {
      const built = await build();
      const tampered = withSubstitutedAccount(
        built.base64,
        SubscriptionsInstruction.TransferSubscription,
        0,
        2,
        OTHER[0],
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_authority' });
    });

    it("refuses a substituted tokenMint on the recipient pull — isolated from subscribeData's identical field", async () => {
      const built = await build();
      const tampered = withSubstitutedAccount(
        built.base64,
        SubscriptionsInstruction.TransferSubscription,
        0,
        6,
        OTHER[2],
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_terms' });
    });
  });

  describe('phase-boundary reasons: an instruction missing, or the wrong program, at each fixed position', () => {
    it('refuses a transaction that ends after the ComputeBudget prefix when an authority init is expected', async () => {
      const built = await build({ authorityExists: false });
      const tampered = withInstructions(built.base64, (ix) =>
        ix.filter((instr) => instr.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), {
        ...base,
        authorityExists: false,
      });
      expect(result).toEqual({ ok: false, reason: 'missing_authority_init' });
    });

    it('refuses a foreign program instruction where the authority init belongs', async () => {
      const built = await build({ authorityExists: false });
      const tampered = withInstructions(built.base64, (ix) =>
        ix.map((instr) => {
          if (instr.programAddress !== SUBSCRIPTIONS_PROGRAM_ID) return instr;
          if (
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) !==
            SubscriptionsInstruction.InitSubscriptionAuthority
          ) {
            return instr;
          }
          return getTransferCheckedInstruction({
            source: address(base.payerTokenAccount),
            mint: address(MINT),
            destination: address(OTHER[0]),
            authority: address(base.payerWallet),
            amount: 1n,
            decimals: 6,
          });
        }),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), {
        ...base,
        authorityExists: false,
      });
      expect(result).toEqual({ ok: false, reason: 'unexpected_program' });
    });

    it('refuses a transaction that ends right after the ComputeBudget prefix when subscribe is expected', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) =>
        ix.filter((instr) => instr.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'missing_subscribe' });
    });

    it('refuses a pull sitting where subscribe belongs (right Subscriptions program, wrong kind)', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) => {
        const recipientPull = ix.find(
          (instr) =>
            instr.programAddress === SUBSCRIPTIONS_PROGRAM_ID &&
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) ===
              SubscriptionsInstruction.TransferSubscription,
        )!;
        return ix.map((instr) =>
          instr.programAddress === SUBSCRIPTIONS_PROGRAM_ID &&
          identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) === SubscriptionsInstruction.Subscribe
            ? recipientPull
            : instr,
        );
      });
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'missing_subscribe' });
    });

    it('refuses a transaction with nothing where the recipient pull belongs', async () => {
      const zero = { ...base, feeAmount: 0n, capAmount: 10_000_000n, feeRecipientTokenAccount: null };
      const built = await buildSubscribeTransaction({
        ...zero,
        computeUnitLimit: 400_000,
        computeUnitPriceMicroLamports: 1_000n,
        lastValidBlockHeight: 1_000n,
      });
      const tampered = withInstructions(built.base64, (ix) =>
        ix.filter(
          (instr) =>
            instr.programAddress !== SUBSCRIPTIONS_PROGRAM_ID ||
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) !==
              SubscriptionsInstruction.TransferSubscription,
        ),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), zero);
      expect(result).toEqual({ ok: false, reason: 'wrong_transfer_count' });
    });

    it('refuses a foreign program instruction where the recipient pull belongs', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) =>
        ix.map((instr) => {
          if (instr.programAddress !== SUBSCRIPTIONS_PROGRAM_ID) return instr;
          if (
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) !==
            SubscriptionsInstruction.TransferSubscription
          ) {
            return instr;
          }
          return getTransferCheckedInstruction({
            source: address(base.payerTokenAccount),
            mint: address(MINT),
            destination: address(OTHER[0]),
            authority: address(base.payerWallet),
            amount: 1n,
            decimals: 6,
          });
        }),
      );
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'unexpected_program' });
    });

    it('refuses a duplicate subscribe where the recipient pull belongs', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) => {
        const subscribeInstr = ix.find(
          (instr) =>
            instr.programAddress === SUBSCRIPTIONS_PROGRAM_ID &&
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) === SubscriptionsInstruction.Subscribe,
        )!;
        let replaced = false;
        return ix.map((instr) => {
          if (
            !replaced &&
            instr.programAddress === SUBSCRIPTIONS_PROGRAM_ID &&
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) ===
              SubscriptionsInstruction.TransferSubscription
          ) {
            replaced = true;
            return subscribeInstr;
          }
          return instr;
        });
      });
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_transfer_count' });
    });

    it('refuses a transaction with nothing where the fee recipient pull belongs (fee > 0 still expected)', async () => {
      const built = await build();
      // Drops only the LAST TransferSubscription (the fee recipient pull), keeping the recipient
      // pull that precedes it — the fixed order means "last" and "second" coincide here.
      const withoutFeeRecipientPull = withInstructions(built.base64, (ix) => {
        const lastPullIndex = ix.reduce((last, instr, i) => {
          const isPull =
            instr.programAddress === SUBSCRIPTIONS_PROGRAM_ID &&
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) ===
              SubscriptionsInstruction.TransferSubscription;
          return isPull ? i : last;
        }, -1);
        return ix.filter((_, i) => i !== lastPullIndex);
      });
      const result = await validateSignedSubscribe(await payerSign(withoutFeeRecipientPull), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_transfer_count' });
    });

    it('refuses a foreign program instruction where the fee recipient pull belongs', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) => {
        let seen = 0;
        return ix.map((instr) => {
          if (
            instr.programAddress === SUBSCRIPTIONS_PROGRAM_ID &&
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) ===
              SubscriptionsInstruction.TransferSubscription
          ) {
            seen += 1;
            if (seen === 2) {
              return getTransferCheckedInstruction({
                source: address(base.payerTokenAccount),
                mint: address(MINT),
                destination: address(OTHER[0]),
                authority: address(base.payerWallet),
                amount: 1n,
                decimals: 6,
              });
            }
          }
          return instr;
        });
      });
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'unexpected_program' });
    });

    it('refuses a duplicate subscribe where the fee recipient pull belongs', async () => {
      const built = await build();
      const tampered = withInstructions(built.base64, (ix) => {
        const subscribeInstr = ix.find(
          (instr) =>
            instr.programAddress === SUBSCRIPTIONS_PROGRAM_ID &&
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) === SubscriptionsInstruction.Subscribe,
        )!;
        let seen = 0;
        return ix.map((instr) => {
          if (
            instr.programAddress === SUBSCRIPTIONS_PROGRAM_ID &&
            identifySubscriptionsInstruction(instr as unknown as { data: Uint8Array }) ===
              SubscriptionsInstruction.TransferSubscription
          ) {
            seen += 1;
            if (seen === 2) return subscribeInstr;
          }
          return instr;
        });
      });
      const result = await validateSignedSubscribe(await payerSign(tampered), base);
      expect(result).toEqual({ ok: false, reason: 'wrong_transfer_count' });
    });

    it('refuses a genuine fee recipient pull in the bytes when the expectation says the fee is zero but names no fee recipient account', async () => {
      // A caller-side inconsistency (feeAmount > 0 with feeRecipientTokenAccount null) rather than
      // a payer attack, but the guard exists and must be provably load-bearing regardless.
      const built = await build();
      const result = await validateSignedSubscribe(await payerSign(built.base64), {
        ...base,
        feeRecipientTokenAccount: null,
      });
      expect(result).toEqual({ ok: false, reason: 'wrong_transfer_count' });
    });
  });
});

describe('a discounted subscribe under the full-price cap', () => {
  // Plan cap 10.5 USDC (10 + 5 % fee); the payer subscribes at 50 % off: 5 + 0.25 pulled now.
  const discounted = () => ({ ...base, amount: 5_000_000n, feeAmount: 250_000n });

  it('builds: the payer approves the plan cap, the pulls take the discounted charge', async () => {
    const built = await build(discounted());
    const result = await validateSignedSubscribe(await payerSign(built.base64), discounted());
    expect(result.ok).toBe(true);
    // What the payer signs: expectedAmount = the plan cap, recipient pull = amount, fee recipient pull = fee + network fee.
    const message = decompileTransactionMessage(
      getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(getBase64Encoder().encode(built.base64)).messageBytes,
      ),
    );
    const parsed = message.instructions
      .filter((instr) => instr.programAddress === SUBSCRIPTIONS_PROGRAM_ID)
      .map((instr) => parseSubscriptionsInstruction(instr as never));
    const subscribe = parsed.find((p) => p.instructionType === SubscriptionsInstruction.Subscribe);
    const pulls = parsed.filter((p) => p.instructionType === SubscriptionsInstruction.TransferSubscription);
    expect(subscribe && 'subscribeData' in subscribe.data ? subscribe.data.subscribeData.expectedAmount : null).toBe(10_500_000n);
    expect(pulls.map((p) => ('transferData' in p.data ? p.data.transferData.amount : null))).toEqual([5_000_000n, 250_000n]);
  });

  it('a discounted subscribe with a network fee: one fee recipient pull of fee + network fee, total under the cap', async () => {
    const withNetworkFee = () => ({ ...base, amount: 5_000_000n, feeAmount: 250_000n, networkFeeAmount: 10_000n, capAmount: 10_510_000n });
    const built = await build(withNetworkFee());
    expect((await validateSignedSubscribe(await payerSign(built.base64), withNetworkFee())).ok).toBe(true);
  });

  it('a discounted subscribe at a zero fee and network fee omits the fee recipient pull', async () => {
    const zero = () => ({ ...base, amount: 5_000_000n, feeAmount: 0n, capAmount: 10_000_000n, feeRecipientTokenAccount: null });
    const built = await build(zero());
    expect((await validateSignedSubscribe(await payerSign(built.base64), zero())).ok).toBe(true);
  });

  it('refuses a transaction whose pulls are the full price when the first charge is discounted', async () => {
    const full = await build();
    expect(await validateSignedSubscribe(await payerSign(full.base64), discounted())).toEqual({ ok: false, reason: 'wrong_amount' });
  });

  it('refuses a transaction whose pulls are the discounted price when the first charge is not', async () => {
    const built = await build(discounted());
    expect(await validateSignedSubscribe(await payerSign(built.base64), base)).toEqual({ ok: false, reason: 'wrong_amount' });
  });

  it('refuses a transaction approving a smaller cap than the plan', async () => {
    const built = await build({ ...discounted(), capAmount: 5_250_000n });
    expect(await validateSignedSubscribe(await payerSign(built.base64), discounted())).toEqual({ ok: false, reason: 'wrong_terms' });
  });

  it('refuses a transaction approving a larger cap than the plan', async () => {
    const built = await build({ ...discounted(), capAmount: 10_600_000n });
    expect(await validateSignedSubscribe(await payerSign(built.base64), discounted())).toEqual({ ok: false, reason: 'wrong_terms' });
  });

  it('refuses, before decoding, an expectation whose charge exceeds its cap', async () => {
    const built = await build(discounted());
    expect(await validateSignedSubscribe(await payerSign(built.base64), { ...base, amount: 11_000_000n })).toEqual({ ok: false, reason: 'wrong_amount' });
    // One unit over the cap, through the fee or the network fee alone.
    expect(await validateSignedSubscribe(await payerSign(built.base64), { ...base, feeAmount: 500_001n })).toEqual({ ok: false, reason: 'wrong_amount' });
    expect(await validateSignedSubscribe(await payerSign(built.base64), { ...base, networkFeeAmount: 1n })).toEqual({ ok: false, reason: 'wrong_amount' });
    // Undecodable bytes still refuse wrong_amount: the check runs first.
    expect(await validateSignedSubscribe('AAAA', { ...base, amount: 11_000_000n })).toEqual({ ok: false, reason: 'wrong_amount' });
  });

  it('refuses an expectation paying nothing to the recipient', async () => {
    expect(await validateSignedSubscribe('AAAA', { ...base, amount: 0n })).toEqual({ ok: false, reason: 'wrong_amount' });
  });

  it('refuses a negative fee or network fee that would let the recipient pull alone exceed the cap', async () => {
    const opts = { computeUnitLimit: 40_000, computeUnitPriceMicroLamports: 1n, lastValidBlockHeight: 1n };
    expect(await validateSignedSubscribe('AAAA', { ...base, amount: 10_600_000n, feeAmount: -100_000n })).toEqual({ ok: false, reason: 'wrong_amount' });
    expect(await validateSignedSubscribe('AAAA', { ...base, amount: 10_600_000n, networkFeeAmount: -100_000n })).toEqual({ ok: false, reason: 'wrong_amount' });
    await expect(buildSubscribeTransaction({ ...base, amount: 10_600_000n, feeAmount: -100_000n, ...opts })).rejects.toThrow('cap');
  });
});
