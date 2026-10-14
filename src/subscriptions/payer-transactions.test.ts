import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
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
import {
  getCancelSubscriptionInstruction,
  getInitSubscriptionAuthorityInstruction,
  getRevokeSubscriptionOverlayInstruction,
} from '@solana/subscriptions';
import { MAX_SIGNED_TRANSACTION_BASE64 } from '../payment-transaction.js';
import { TOKEN_PROGRAM_ADDRESS } from '../solana.constants.js';
import { deriveEventAuthorityAddress } from './addresses.js';
import {
  buildPayerActionTransaction,
  validateSignedPayerAction,
  type PayerActionExpectation,
} from './payer-transactions.js';

const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
const OTHER_BLOCKHASH = 'BXGYJLMVYsBsBTsUW5BGJjvUqrXJn8FZeNyQYD5oAnCk';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PLAN = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const SUBSCRIPTION = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const AUTHORITY = 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse';
const TOKEN_ACCOUNT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
/** A valid address that is none of the above — for "exactly one account differs". */
const OTHER = 'SysvarRent111111111111111111111111111111111';
const KINDS = ['cancel', 'revoke', 'reauthorize'] as const;
/** The compiled message's instruction list, which the decoder's public type does not expose. */
type CompiledWithInstructions = { instructions: { programAddressIndex: number; accountIndices?: number[] }[] };

let payer: KeyPairSigner;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
});

function expectationFor(
  kind: PayerActionExpectation['kind'],
  overrides: { payerWallet?: string; subscriptionAddress?: string; blockhash?: string } = {},
): PayerActionExpectation {
  const payerWallet = overrides.payerWallet ?? payer.address;
  const blockhash = overrides.blockhash ?? BLOCKHASH;
  if (kind === 'reauthorize') {
    return {
      kind,
      payerWallet,
      authorityAddress: AUTHORITY,
      mint: MINT,
      payerTokenAccount: TOKEN_ACCOUNT,
      blockhash,
    };
  }
  return {
    kind,
    payerWallet,
    planAddress: PLAN,
    subscriptionAddress: overrides.subscriptionAddress ?? SUBSCRIPTION,
    blockhash,
  };
}

async function built(expectation: PayerActionExpectation): Promise<string> {
  const { base64 } = await buildPayerActionTransaction({
    expectation,
    lastValidBlockHeight: 1_150n,
    computeUnitLimit: 100_000,
    computeUnitPriceMicroLamports: 1_000n,
  });
  return base64;
}

/** What a wallet does: signTransaction, never signAndSend. */
async function sign(base64: string): Promise<string> {
  return getBase64EncodedWireTransaction(
    await partiallySignTransaction(
      [payer.keyPair],
      getTransactionDecoder().decode(getBase64Encoder().encode(base64)),
    ),
  );
}

/** A hand-built message, for shapes the library's own builder would never produce. */
function compileWith(instructions: Instruction[]): string {
  const message = pipe(
    createTransactionMessage({ version: 'legacy' as const }),
    (current) => setTransactionMessageFeePayer(address(payer.address), current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_150n },
        current,
      ),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

async function cancelInstruction(planRole?: AccountRole): Promise<Instruction> {
  const instruction = getCancelSubscriptionInstruction({
    subscriber: createNoopSigner(address(payer.address)),
    planPda: address(PLAN),
    subscriptionPda: address(SUBSCRIPTION),
    eventAuthority: address(await deriveEventAuthorityAddress()),
  });
  if (planRole === undefined) return instruction;
  return {
    ...instruction,
    accounts: instruction.accounts.map((meta, index) => (index === 1 ? { ...meta, role: planRole } : meta)),
  } as Instruction;
}

/** `[payer(signer), subscriptionAddress, planAddress]` — index 2 (planAddress) is READONLY. */
function revokeInstruction(planRole?: AccountRole): Instruction {
  const instruction = getRevokeSubscriptionOverlayInstruction({
    authority: createNoopSigner(address(payer.address)),
    planPda: address(PLAN),
    subscriptionPda: address(SUBSCRIPTION),
  });
  if (planRole === undefined) return instruction;
  return {
    ...instruction,
    accounts: instruction.accounts!.map((meta, index) => (index === 2 ? { ...meta, role: planRole } : meta)),
  } as Instruction;
}

/** `[payer(signer), authorityAddress, mint, payerTokenAccount, system, tokenProgram]` — index 2
 *  (mint) is READONLY. */
function reauthorizeInstruction(mintRole?: AccountRole): Instruction {
  const instruction = getInitSubscriptionAuthorityInstruction({
    owner: createNoopSigner(address(payer.address)),
    subscriptionAuthority: address(AUTHORITY),
    tokenMint: address(MINT),
    userAta: address(TOKEN_ACCOUNT),
    tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
  });
  if (mintRole === undefined) return instruction;
  return {
    ...instruction,
    accounts: instruction.accounts.map((meta, index) => (index === 2 ? { ...meta, role: mintRole } : meta)),
  } as Instruction;
}

const limit = () => getSetComputeUnitLimitInstruction({ units: 100_000 });
const price = () => getSetComputeUnitPriceInstruction({ microLamports: 1_000n });

/**
 * Mutates one or more of the compiled message's three HEADER counts and returns the
 * re-encoded, UNSIGNED message bytes — never a signed transaction, because the point is to
 * sign the TAMPERED bytes for real (below), the way a payer's own wallet would if it (or an
 * attacker skipping the wallet entirely) built the message this way from the start.
 */
function messageBytesWithHeaderPatch(
  unsignedBase64: string,
  patch: Partial<{
    numSignerAccounts: number;
    numReadonlySignerAccounts: number;
    numReadonlyNonSignerAccounts: number;
  }>,
): Uint8Array {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(unsignedBase64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const mutated = { ...compiled, header: { ...compiled.header, ...patch } };
  return getCompiledTransactionMessageEncoder().encode(mutated as never) as unknown as Uint8Array;
}

/**
 * Signs arbitrary message bytes with the payer's real Ed25519 key directly via WebCrypto —
 * bypassing `partiallySignTransaction`'s own internal consistency checks entirely (it refuses
 * to even decode a message whose signature-slot count disagrees with its header). A payer's
 * wallet only ever signs bytes; nothing requires those bytes to have come from
 * `compileTransaction`, so this is exactly as capable as a real forged payload.
 */
async function signRawMessageBytes(messageBytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('Ed25519', payer.keyPair.privateKey, messageBytes));
}

/** One shortvec-encoded signature count (always 1 here) + the signature + the message —
 *  built by hand, so nothing about this wire transaction ever passed through the SDK's own
 *  encoder or its cross-checks. */
async function signedWireFromMessageBytes(messageBytes: Uint8Array): Promise<string> {
  const signature = await signRawMessageBytes(messageBytes);
  return Buffer.concat([Buffer.from([1]), Buffer.from(signature), Buffer.from(messageBytes)]).toString(
    'base64',
  );
}

/** Appends one address to the STATIC ACCOUNT LIST directly, below
 *  `appendTransactionMessageInstructions`'s abstraction, so it is referenced by NO instruction
 *  at all — the one shape `compileWith` cannot produce (anything it builds is, by
 *  construction, referenced by some instruction). */
function withUnreferencedStaticAccount(base64: string, extraAddress: string): string {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const mutated = {
    ...compiled,
    staticAccounts: [...compiled.staticAccounts, address(extraAddress)],
    header: {
      ...compiled.header,
      // Appended after every writable and every other read-only account — exactly where a
      // read-only, non-signer account belongs, so only this one count changes.
      numReadonlyNonSignerAccounts: compiled.header.numReadonlyNonSignerAccounts + 1,
    },
  };
  const newMessageBytes = getCompiledTransactionMessageEncoder().encode(mutated as never);
  return getBase64EncodedWireTransaction({ ...transaction, messageBytes: newMessageBytes } as never);
}

/**
 * Inserts a THIRD signer requirement — a brand new address nothing in the message ever
 * actually signs for — at the compiled-message level, and shifts every instruction's
 * account-index references that pointed past the insertion point, so the message stays
 * internally consistent: every instruction still resolves to the SAME accounts it did before.
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

describe('payer-signed actions', () => {
  it.each(KINDS)('a %s built here and signed by the payer validates', async (kind) => {
    const expectation = expectationFor(kind);
    const result = await validateSignedPayerAction(await sign(await built(expectation)), expectation);
    expect(result.ok).toBe(true);
  });

  it('every built action has exactly one signer — the payer, who also pays the fee — and no other key', async () => {
    for (const kind of KINDS) {
      const transaction = getTransactionDecoder().decode(
        getBase64Encoder().encode(await built(expectationFor(kind))),
      );
      const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      expect(compiled.header.numSignerAccounts).toBe(1);
      expect(compiled.staticAccounts[0]).toBe(payer.address);
      expect(Object.keys(transaction.signatures)).toEqual([payer.address]);
    }
  });

  it('refuses a different blockhash', async () => {
    const signed = await sign(await built(expectationFor('cancel', { blockhash: OTHER_BLOCKHASH })));
    expect(await validateSignedPayerAction(signed, expectationFor('cancel'))).toEqual({
      ok: false,
      reason: 'wrong_blockhash',
    });
  });

  it('refuses another fee payer', async () => {
    const other = await generateKeyPairSigner();
    const unsigned = await built(expectationFor('cancel', { payerWallet: other.address }));
    expect(await validateSignedPayerAction(unsigned, expectationFor('cancel'))).toEqual({
      ok: false,
      reason: 'wrong_fee_payer',
    });
  });

  it('refuses a transaction the payer never signed', async () => {
    const expectation = expectationFor('cancel');
    expect(await validateSignedPayerAction(await built(expectation), expectation)).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
  });

  it('refuses a signature that does not match the message', async () => {
    const expectation = expectationFor('cancel');
    const bytes = Buffer.from(await sign(await built(expectation)), 'base64');
    bytes[1] ^= 0xff; // inside the first signature, never the message
    expect(await validateSignedPayerAction(bytes.toString('base64'), expectation)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a substituted subscription account', async () => {
    const signed = await sign(await built(expectationFor('cancel', { subscriptionAddress: OTHER })));
    expect(await validateSignedPayerAction(signed, expectationFor('cancel'))).toEqual({
      ok: false,
      reason: 'wrong_accounts',
    });
  });

  it('refuses a revoke where a cancel was built', async () => {
    const signed = await sign(await built(expectationFor('revoke')));
    expect(await validateSignedPayerAction(signed, expectationFor('cancel'))).toEqual({
      ok: false,
      reason: 'missing_action',
    });
  });

  it('refuses anything after the action', async () => {
    const signed = await sign(compileWith([limit(), price(), await cancelInstruction(), await cancelInstruction()]));
    expect(await validateSignedPayerAction(signed, expectationFor('cancel'))).toEqual({
      ok: false,
      reason: 'unexpected_instruction',
    });
  });

  it('refuses a compute-budget instruction that names an account', async () => {
    const tainted = {
      ...limit(),
      accounts: [{ address: address(payer.address), role: AccountRole.READONLY }],
    } as Instruction;
    const signed = await sign(compileWith([tainted, await cancelInstruction()]));
    expect(await validateSignedPayerAction(signed, expectationFor('cancel'))).toEqual({
      ok: false,
      reason: 'unexpected_instruction',
    });
  });

  it("accepts a wallet's own extra compute-budget instruction (the payer pays for it)", async () => {
    const signed = await sign(
      compileWith([limit(), price(), getSetComputeUnitPriceInstruction({ microLamports: 5_000n }), await cancelInstruction()]),
    );
    expect((await validateSignedPayerAction(signed, expectationFor('cancel'))).ok).toBe(true);
  });

  it('refuses the plan account promoted to writable', async () => {
    const signed = await sign(compileWith([limit(), price(), await cancelInstruction(AccountRole.WRITABLE)]));
    expect(await validateSignedPayerAction(signed, expectationFor('cancel'))).toEqual({
      ok: false,
      reason: 'wrong_accounts',
    });
  });

  it('refuses an oversized payload before decoding it', async () => {
    expect(
      await validateSignedPayerAction('A'.repeat(MAX_SIGNED_TRANSACTION_BASE64 + 1), expectationFor('cancel')),
    ).toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses bytes that are not a transaction', async () => {
    expect(await validateSignedPayerAction('AAAA', expectationFor('cancel'))).toEqual({
      ok: false,
      reason: 'undecodable',
    });
  });
});

describe('payer-signed actions — structural attacks', () => {
  describe('header bounds', () => {
    // Every case here signs the TAMPERED bytes for real (`signedWireFromMessageBytes`), so a
    // refusal can only come from a structural check, never from a signature that no longer
    // matches. All three are refused; only the third is uniquely `headerBoundsAreSane`'s doing
    // — the other two are ALSO refused by protections that exist independently of it (the
    // kit decoder itself refuses a signer count that disagrees with the message, and the
    // signer check already demands exactly zero read-only signers), which a mutation test
    // confirms by removing only the third condition's guard.

    it('refuses byte 0 — a signer count the message cannot even represent', async () => {
      const bytes = messageBytesWithHeaderPatch(await built(expectationFor('cancel')), {
        numSignerAccounts: 111,
      });
      const signed = await signedWireFromMessageBytes(bytes);
      expect((await validateSignedPayerAction(signed, expectationFor('cancel'))).ok).toBe(false);
    });

    it('refuses byte 1 — more read-only signers than signers', async () => {
      const bytes = messageBytesWithHeaderPatch(await built(expectationFor('cancel')), {
        numReadonlySignerAccounts: 2,
      });
      const signed = await signedWireFromMessageBytes(bytes);
      expect((await validateSignedPayerAction(signed, expectationFor('cancel'))).ok).toBe(false);
    });

    it("refuses byte 2 — more read-only non-signers than the message has room for", async () => {
      const bytes = messageBytesWithHeaderPatch(await built(expectationFor('cancel')), {
        numReadonlyNonSignerAccounts: 10,
      });
      const signed = await signedWireFromMessageBytes(bytes);
      // Pinned to the SPECIFIC reason `headerBoundsAreSane` returns: this is the one case a
      // mutation test shows flips all the way to `ok: true` (not merely a different refusal)
      // when the guard is removed — the writable-set slice's end index goes negative and
      // narrows to exactly `shape.writable` by coincidence.
      expect(await validateSignedPayerAction(signed, expectationFor('cancel'))).toEqual({
        ok: false,
        reason: 'wrong_signers',
      });
    });
  });

  describe('trailing signed bytes', () => {
    it('refuses bytes after the compiled message that the payer signed too', async () => {
      const unsigned = await built(expectationFor('cancel'));
      const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(unsigned));
      const trailingMessageBytes = new Uint8Array([...transaction.messageBytes, 9, 9, 9]);
      const signature = await signRawMessageBytes(trailingMessageBytes);
      const signed = Buffer.concat([
        Buffer.from([1]),
        Buffer.from(signature),
        Buffer.from(trailingMessageBytes),
      ]).toString('base64');
      expect(await validateSignedPayerAction(signed, expectationFor('cancel'))).toEqual({
        ok: false,
        reason: 'trailing_bytes',
      });
    });
  });

  describe('coverage gaps', () => {
    it('refuses an extra, unreferenced read-only static account', async () => {
      const signed = withUnreferencedStaticAccount(await sign(await built(expectationFor('cancel'))), OTHER);
      expect(await validateSignedPayerAction(signed, expectationFor('cancel'))).toEqual({
        ok: false,
        reason: 'wrong_accounts',
      });
    });

    it('refuses a different program id for the action', async () => {
      const tampered = { ...(await cancelInstruction()), programAddress: address(TOKEN_PROGRAM_ADDRESS) };
      const signed = await sign(compileWith([limit(), price(), tampered as Instruction]));
      expect(await validateSignedPayerAction(signed, expectationFor('cancel'))).toEqual({
        ok: false,
        reason: 'unexpected_program',
      });
    });

    it('refuses a v0 message with an address lookup table', async () => {
      const lookupTable = OTHER;
      const action = await cancelInstruction();
      let v0Message = pipe(
        createTransactionMessage({ version: 0 }),
        (current) => setTransactionMessageFeePayer(address(payer.address), current),
        (current) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_150n },
            current,
          ),
        (current) => appendTransactionMessageInstructions([limit(), price(), action], current),
      );
      v0Message = compressTransactionMessageUsingAddressLookupTables(v0Message, {
        [lookupTable]: [PLAN],
      } as never) as unknown as typeof v0Message;
      const signed = await sign(getBase64EncodedWireTransaction(compileTransaction(v0Message)));
      expect(await validateSignedPayerAction(signed, expectationFor('cancel'))).toEqual({
        ok: false,
        reason: 'not_legacy',
      });
    });

    it('refuses an extra signer', async () => {
      const other = await generateKeyPairSigner();
      const unsignedWithExtraSigner = withExtraUnfilledSigner(await built(expectationFor('cancel')), other.address);
      const signed = getBase64EncodedWireTransaction(
        await partiallySignTransaction(
          [payer.keyPair],
          getTransactionDecoder().decode(getBase64Encoder().encode(unsignedWithExtraSigner)),
        ),
      );
      // The extra signer is a brand new static account (never referenced by any
      // instruction), so the static-account-SET check refuses it first — before the
      // separate signer-COUNT check ever runs.
      expect(await validateSignedPayerAction(signed, expectationFor('cancel'))).toEqual({
        ok: false,
        reason: 'wrong_accounts',
      });
    });

    it('refuses the plan account promoted to writable (revoke)', async () => {
      const signed = await sign(compileWith([limit(), price(), revokeInstruction(AccountRole.WRITABLE)]));
      expect(await validateSignedPayerAction(signed, expectationFor('revoke'))).toEqual({
        ok: false,
        reason: 'wrong_accounts',
      });
    });

    it('refuses the mint promoted to writable (reauthorize)', async () => {
      const signed = await sign(compileWith([limit(), price(), reauthorizeInstruction(AccountRole.WRITABLE)]));
      expect(await validateSignedPayerAction(signed, expectationFor('reauthorize'))).toEqual({
        ok: false,
        reason: 'wrong_accounts',
      });
    });
  });
});
