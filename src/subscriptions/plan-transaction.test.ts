import {
  getSetComputeUnitLimitInstructionDataDecoder,
  getSetComputeUnitPriceInstructionDataDecoder,
  SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR,
  SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR,
} from '@solana-program/compute-budget';
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
  identifySubscriptionsInstruction,
  parseSubscriptionsInstruction,
  PlanStatus,
  SubscriptionsInstruction,
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
} from '@solana/subscriptions';
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '../solana.constants.js';
import type { TransactionSigner } from '../transaction-signer.js';
import type { OnchainPlanAccount } from './accounts.js';
import {
  buildCreatePlanTransaction,
  buildSunsetPlanTransaction,
  buildUpdatePlanPullersTransaction,
  planMatches,
} from './plan-transaction.js';

/** Used ONLY by the `planMatches` block, which needs no signer. Everything that is built
 *  and signed uses `ownerSigner.address`. */
const OWNER = '11111111111111111111111111111112';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RECIPIENT = '11111111111111111111111111111113';
const FEE_RECIPIENT = '11111111111111111111111111111114';
const PULLER_FIRST = 'SysvarC1ock11111111111111111111111111111111';
const PULLER_SECOND = '11111111111111111111111111111115';
const DEST_THIRD = '11111111111111111111111111111116';
const DEST_FOURTH = '11111111111111111111111111111117';
const PULLER_THIRD = '11111111111111111111111111111118';
const PULLER_FOURTH = '11111111111111111111111111111119';
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
const ZERO_ADDRESS = '11111111111111111111111111111111';

/**
 * A real signer over a throwaway key. `finish()` signs, so a stub that refuses would fail
 * every build; and `generateKeyPairSigner()`'s key is NON-EXTRACTABLE, so the 64 file bytes
 * have to be built from a seed generated here.
 */
async function realSigner(): Promise<TransactionSigner & { address: string }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keypair = await createKeyPairSignerFromPrivateKeyBytes(seed);
  return {
    address: keypair.address,
    sign: async (base64: string) =>
      getBase64EncodedWireTransaction(
        await partiallySignTransaction(
          [keypair.keyPair],
          getTransactionDecoder().decode(getBase64Encoder().encode(base64)),
        ),
      ),
  };
}

let ownerSigner: TransactionSigner;
beforeAll(async () => {
  ownerSigner = await realSigner();
});

function instructionsOf(base64: string) {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  return { message: decompileTransactionMessage(compiled), compiled };
}

describe('buildCreatePlanTransaction', () => {
  // Built per test, because `ownerSigner` is only assigned in beforeAll.
  const input = () => ({
    owner: ownerSigner,
    planId: 42n,
    mint: MINT,
    capAmount: 10_500_000n,
    periodHours: 720,
    destinations: [RECIPIENT, FEE_RECIPIENT],
    pullers: [PULLER_FIRST, PULLER_SECOND],
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 1_000n,
    computeUnitLimit: 120_000,
    computeUnitPriceMicroLamports: 1_000n,
  });

  it('builds one createPlan bound to exactly the terms it was given', async () => {
    const built = await buildCreatePlanTransaction(input());
    const { message, compiled } = instructionsOf(built.base64);
    expect(compiled.version).toBe('legacy');
    expect(message.feePayer.address).toBe(ownerSigner.address);

    const programInstructions = message.instructions.filter(
      (instruction) => instruction.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS,
    );
    expect(programInstructions).toHaveLength(1);
    expect(
      identifySubscriptionsInstruction(programInstructions[0] as unknown as { data: Uint8Array }),
    ).toBe(SubscriptionsInstruction.CreatePlan);

    const parsed = parseSubscriptionsInstruction(programInstructions[0] as never);
    if (parsed.instructionType !== SubscriptionsInstruction.CreatePlan) throw new Error('wrong kind');
    expect(parsed.data.planData.planId).toBe(42n);
    expect(parsed.data.planData.terms.amount).toBe(10_500_000n);
    expect(parsed.data.planData.terms.periodHours).toBe(720n);
    expect(parsed.data.planData.endTs).toBe(0n);
    expect(parsed.data.planData.destinations.slice(0, 2)).toEqual([
      address(RECIPIENT),
      address(FEE_RECIPIENT),
    ]);
    expect(parsed.data.planData.pullers.slice(0, 2)).toEqual([address(PULLER_FIRST), address(PULLER_SECOND)]);
  });

  it('carries exactly one compute-budget limit and one price instruction, in that order', async () => {
    const { message } = instructionsOf((await buildCreatePlanTransaction(input())).base64);
    const budget = message.instructions.filter(
      (instruction) => instruction.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS,
    );
    expect(budget).toHaveLength(2);
    // Decoded, not just counted: a swap of the two getSetComputeUnit*Instruction calls'
    // positions would still produce two valid compute-budget instructions (neither is
    // individually wrong), so only checking discriminator+value AT EACH POSITION catches an
    // order swap.
    const limitData = getSetComputeUnitLimitInstructionDataDecoder().decode(
      budget[0].data as Uint8Array,
    );
    expect(limitData.discriminator).toBe(SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR);
    expect(limitData.units).toBe(120_000);
    const priceData = getSetComputeUnitPriceInstructionDataDecoder().decode(
      budget[1].data as Uint8Array,
    );
    expect(priceData.discriminator).toBe(SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR);
    expect(priceData.microLamports).toBe(1_000n);
  });

  it('returns the plan address it derived, and it is stable', async () => {
    const first = await buildCreatePlanTransaction(input());
    const second = await buildCreatePlanTransaction(input());
    expect(first.planAddress).toBe(second.planAddress);
    expect(first.planAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('omits a zero-fee fee recipient destination entirely', async () => {
    const built = await buildCreatePlanTransaction({ ...input(), destinations: [RECIPIENT] });
    const { message } = instructionsOf(built.base64);
    const parsed = parseSubscriptionsInstruction(
      message.instructions.find(
        (instruction) => instruction.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS,
      ) as never,
    );
    if (parsed.instructionType !== SubscriptionsInstruction.CreatePlan) throw new Error('wrong kind');
    expect(parsed.data.planData.destinations[0]).toBe(address(RECIPIENT));
    // Slot 1 onwards is the zero-address padding, never a second real destination.
    expect(parsed.data.planData.destinations[1]).toBe(address('11111111111111111111111111111111'));
  });

  it('refuses more destinations or pullers than the program allows', async () => {
    await expect(
      buildCreatePlanTransaction({ ...input(), destinations: [RECIPIENT, FEE_RECIPIENT, PULLER_FIRST, PULLER_SECOND, OWNER] }),
    ).rejects.toThrow('at most 4 destinations');
    await expect(
      buildCreatePlanTransaction({ ...input(), pullers: [RECIPIENT, FEE_RECIPIENT, PULLER_FIRST, PULLER_SECOND, OWNER] }),
    ).rejects.toThrow('at most 4 pullers');
  });

  it('accepts exactly 3 destinations and pullers, in order, with only the last slot padded', async () => {
    const built = await buildCreatePlanTransaction({
      ...input(),
      destinations: [RECIPIENT, FEE_RECIPIENT, DEST_THIRD],
      pullers: [PULLER_FIRST, PULLER_SECOND, PULLER_THIRD],
    });
    const { message } = instructionsOf(built.base64);
    const parsed = parseSubscriptionsInstruction(
      message.instructions.find(
        (instruction) => instruction.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS,
      ) as never,
    );
    if (parsed.instructionType !== SubscriptionsInstruction.CreatePlan) throw new Error('wrong kind');
    // This is where a silent bug would send money to the wrong address: every real slot must
    // land in its own position, and only the trailing, unfilled slot may be zero-address
    // padding.
    expect(parsed.data.planData.destinations).toEqual([
      address(RECIPIENT),
      address(FEE_RECIPIENT),
      address(DEST_THIRD),
      address(ZERO_ADDRESS),
    ]);
    expect(parsed.data.planData.pullers).toEqual([
      address(PULLER_FIRST),
      address(PULLER_SECOND),
      address(PULLER_THIRD),
      address(ZERO_ADDRESS),
    ]);
  });

  it('accepts exactly 4 destinations and pullers, filling every real slot with no padding at all', async () => {
    const built = await buildCreatePlanTransaction({
      ...input(),
      destinations: [RECIPIENT, FEE_RECIPIENT, DEST_THIRD, DEST_FOURTH],
      pullers: [PULLER_FIRST, PULLER_SECOND, PULLER_THIRD, PULLER_FOURTH],
    });
    const { message } = instructionsOf(built.base64);
    const parsed = parseSubscriptionsInstruction(
      message.instructions.find(
        (instruction) => instruction.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS,
      ) as never,
    );
    if (parsed.instructionType !== SubscriptionsInstruction.CreatePlan) throw new Error('wrong kind');
    expect(parsed.data.planData.destinations).toEqual([
      address(RECIPIENT),
      address(FEE_RECIPIENT),
      address(DEST_THIRD),
      address(DEST_FOURTH),
    ]);
    expect(parsed.data.planData.pullers).toEqual([
      address(PULLER_FIRST),
      address(PULLER_SECOND),
      address(PULLER_THIRD),
      address(PULLER_FOURTH),
    ]);
  });
});

describe('buildUpdatePlanPullersTransaction', () => {
  let current: OnchainPlanAccount;
  beforeAll(() => {
    current = {
      owner: ownerSigner.address,
      status: 'ACTIVE',
      planId: 42n,
      mint: MINT,
      amount: 10_500_000n,
      periodHours: 720,
      createdAt: 1_700_000_000n,
      endTs: 0n,
      destinations: [RECIPIENT, FEE_RECIPIENT],
      pullers: [PULLER_FIRST, PULLER_SECOND],
    };
  });

  it('is a compare-and-set on the live plan, keeping its status and end', async () => {
    const built = await buildUpdatePlanPullersTransaction({
      owner: ownerSigner,
      planAddress: 'PLanAddress11111111111111111111111111111111',
      current,
      pullers: [PULLER_SECOND, '11111111111111111111111111111116'],
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1_000n,
      computeUnitLimit: 120_000,
      computeUnitPriceMicroLamports: 1_000n,
    });
    const { message } = instructionsOf(built.base64);
    const parsed = parseSubscriptionsInstruction(
      message.instructions.find(
        (instruction) => instruction.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS,
      ) as never,
    );
    if (parsed.instructionType !== SubscriptionsInstruction.UpdatePlan) throw new Error('wrong kind');
    // The plan stays Active and endless; only the pullers move.
    expect(parsed.data.updatePlanData.endTs).toBe(0n);
    expect(parsed.data.updatePlanData.expectedCreatedAt).toBe(1_700_000_000n);
    expect(parsed.data.updatePlanData.expectedPullers.slice(0, 2)).toEqual([
      address(PULLER_FIRST),
      address(PULLER_SECOND),
    ]);
    expect(parsed.data.updatePlanData.pullers.slice(0, 2)).toEqual([
      address(PULLER_SECOND),
      address('11111111111111111111111111111116'),
    ]);
  });

  it('refuses to touch a SUNSET plan through this builder', async () => {
    await expect(
      buildUpdatePlanPullersTransaction({
        owner: ownerSigner,
        planAddress: 'PLanAddress11111111111111111111111111111111',
        current: { ...current, status: 'SUNSET' },
        pullers: [PULLER_SECOND],
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 1_000n,
        computeUnitLimit: 120_000,
        computeUnitPriceMicroLamports: 1_000n,
      }),
    ).rejects.toThrow('SUNSET');
  });
});

describe('planMatches', () => {
  const plan: OnchainPlanAccount = {
    owner: OWNER,
    status: 'ACTIVE',
    planId: 42n,
    mint: MINT,
    amount: 10_500_000n,
    periodHours: 720,
    createdAt: 1_700_000_000n,
    endTs: 0n,
    destinations: [RECIPIENT, FEE_RECIPIENT],
    pullers: [PULLER_FIRST, PULLER_SECOND],
  };
  const expected = {
    mint: MINT,
    capAmount: 10_500_000n,
    periodHours: 720,
    destinations: [RECIPIENT, FEE_RECIPIENT],
    pullers: [PULLER_FIRST, PULLER_SECOND],
  };

  it('accepts a plan that is exactly what was asked for, in any order', () => {
    expect(planMatches(plan, expected)).toBe(true);
    expect(
      planMatches({ ...plan, destinations: [FEE_RECIPIENT, RECIPIENT] }, expected),
    ).toBe(true);
  });

  it.each([
    ['a different cap', { ...plan, amount: 10_000_000n }],
    ['a different period', { ...plan, periodHours: 8760 }],
    ['a different mint', { ...plan, mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' }],
    ['a missing destination', { ...plan, destinations: [RECIPIENT] }],
    ['an extra destination', { ...plan, destinations: [RECIPIENT, FEE_RECIPIENT, OWNER] }],
    ['a missing puller', { ...plan, pullers: [PULLER_FIRST] }],
    ['a sunset plan', { ...plan, status: 'SUNSET' as const }],
    ['a plan with an end date', { ...plan, endTs: 1_800_000_000n }],
  ])('rejects %s', (_label, wrong) => {
    expect(planMatches(wrong, expected)).toBe(false);
  });
});

describe('buildSunsetPlanTransaction', () => {
  const live = (): OnchainPlanAccount => ({
    owner: ownerSigner.address,
    status: 'ACTIVE',
    planId: 42n,
    mint: MINT,
    amount: 10_500_000n,
    periodHours: 720,
    createdAt: 1_700_000_000n,
    endTs: 0n,
    destinations: [RECIPIENT, FEE_RECIPIENT],
    pullers: [PULLER_FIRST, PULLER_SECOND],
  });
  const build = (current: OnchainPlanAccount, endTs = 1_800_000_000n) =>
    buildSunsetPlanTransaction({
      owner: ownerSigner,
      planAddress: 'PLanAddress11111111111111111111111111111111',
      current,
      endTs,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1_000n,
      computeUnitLimit: 120_000,
      computeUnitPriceMicroLamports: 1_000n,
    });

  it('sunsets with the given end and removes every puller, compare-and-set on the live plan', async () => {
    const built = await build(live());
    const { message } = instructionsOf(built.base64);
    const parsed = parseSubscriptionsInstruction(
      message.instructions.find(
        (instruction) => instruction.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS,
      ) as never,
    );
    if (parsed.instructionType !== SubscriptionsInstruction.UpdatePlan) throw new Error('wrong kind');
    const data = parsed.data.updatePlanData;
    expect(data.status).toBe(PlanStatus.Sunset);
    expect(data.endTs).toBe(1_800_000_000n);
    expect(data.pullers).toEqual(Array.from({ length: 4 }, () => address(ZERO_ADDRESS)));
    expect(data.expectedCreatedAt).toBe(1_700_000_000n);
    expect(data.expectedEndTs).toBe(0n);
    expect(data.expectedPullers.slice(0, 2)).toEqual([address(PULLER_FIRST), address(PULLER_SECOND)]);
  });

  it('refuses a plan already sunset, and an end later than a finite one already set', async () => {
    await expect(build({ ...live(), status: 'SUNSET' })).rejects.toThrow('already sunset');
    await expect(build({ ...live(), endTs: 1_750_000_000n }, 1_800_000_000n)).rejects.toThrow(
      'brought forward',
    );
  });
});
