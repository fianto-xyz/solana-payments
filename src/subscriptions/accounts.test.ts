import {
  getSubscriptionAuthorityEncoder,
  getSubscriptionDelegationEncoder,
} from '@solana/subscriptions';
import {
  decodeAuthorityAccount,
  decodePlanAccount,
  decodeSubscriptionAccount,
  readAuthorityAccount,
  readPlanAccount,
  readSubscriptionAccount,
  type OnchainAuthorityAccount,
  type OnchainPlanAccount,
  type OnchainSubscriptionAccount,
} from './accounts.js';
import { encodePlanAccountForTests } from './test-helpers.js';
import { SUBSCRIPTIONS_PROGRAM_ID } from './subscriptions-program.constants.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const RENT = 890_880n;

const PLAN: OnchainPlanAccount = {
  owner: '11111111111111111111111111111112',
  status: 'ACTIVE',
  planId: 42n,
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: 10_500_000n,
  periodHours: 720,
  createdAt: 1_700_000_000n,
  endTs: 0n,
  destinations: ['11111111111111111111111111111113', '11111111111111111111111111111114'],
  pullers: ['11111111111111111111111111111115'],
};

describe('decodePlanAccount', () => {
  it('round-trips a fully specified Active plan', () => {
    // NOTE: this fixture is built with the SDK's own getPlanEncoder() and decoded with its own
    // getPlanDecoder() — the same codec pair. It proves the field-path mapping below and the
    // padding filter, but nothing about real on-chain byte offsets or that the program itself
    // writes AccountDiscriminator.Plan into byte 0: if the SDK's view of the layout were wrong,
    // encoder and decoder would be wrong together and this test would still be green.
    const decoded = decodePlanAccount(encodePlanAccountForTests(PLAN));
    expect(decoded).toMatchObject({
      owner: PLAN.owner,
      status: 'ACTIVE',
      planId: 42n,
      mint: PLAN.mint,
      amount: 10_500_000n,
      periodHours: 720,
      createdAt: 1_700_000_000n,
      endTs: 0n,
    });
    // The empty slots of the fixed 4-wide arrays are dropped, never surfaced as an address.
    expect(decoded?.destinations).toEqual(PLAN.destinations);
    expect(decoded?.pullers).toEqual(PLAN.pullers);
  });

  it('returns null rather than throwing for bytes that are not a plan', () => {
    expect(decodePlanAccount('')).toBeNull();
    expect(decodePlanAccount('AQID')).toBeNull();
    expect(decodePlanAccount('not base64 at all!!')).toBeNull();
  });

  it('returns null for a right-sized account with the wrong discriminator', () => {
    const bytes = Buffer.from(encodePlanAccountForTests(PLAN), 'base64');
    bytes[0] = 4; // SubscriptionDelegation, not Plan
    expect(decodePlanAccount(bytes.toString('base64'))).toBeNull();
  });

  it('returns null for a status byte the program never writes, rather than guessing SUNSET', () => {
    // Only 0 (Sunset) and 1 (Active) are real. byte 34 is `status`: discriminator(1) +
    // owner(32) + bump(1) = offset 34. A wrong account, a truncated read, or a future status
    // value must all fail loudly here — never decode into a plausible-looking struct.
    const bytes = Buffer.from(encodePlanAccountForTests(PLAN), 'base64');
    expect(bytes[34]).toBe(1); // sanity: this really is the status byte, and PLAN is Active
    bytes[34] = 7;
    expect(decodePlanAccount(bytes.toString('base64'))).toBeNull();
  });

  it('returns null for a buffer that is not exactly PLAN_ACCOUNT_BYTES long', () => {
    const bytes = Buffer.from(encodePlanAccountForTests(PLAN), 'base64');
    // Truncated: a partial read must not decode into a plausible-looking (wrong) struct.
    expect(decodePlanAccount(bytes.subarray(0, bytes.length - 1).toString('base64'))).toBeNull();
    // Overlong: without the exact-length gate the decoder reads only the first
    // PLAN_ACCOUNT_BYTES and silently ignores the rest, tolerating trailing junk from a
    // wrong-sized or future-layout account. The gate must refuse this too.
    expect(
      decodePlanAccount(Buffer.concat([bytes, Buffer.from([0])]).toString('base64')),
    ).toBeNull();
  });
});

describe('readPlanAccount (owner-aware)', () => {
  it('is ABSENT when missing, not program-owned, or empty', () => {
    expect(readPlanAccount(null)).toEqual({ state: 'absent' });
    expect(readPlanAccount({ owner: SYSTEM_PROGRAM, lamports: RENT, dataBase64: '' })).toEqual({
      state: 'absent',
    });
    expect(
      readPlanAccount({ owner: SYSTEM_PROGRAM, lamports: RENT, dataBase64: encodePlanAccountForTests(PLAN) }),
    ).toEqual({ state: 'absent' });
    expect(readPlanAccount({ owner: SUBSCRIPTIONS_PROGRAM_ID, lamports: RENT, dataBase64: '' })).toEqual({
      state: 'absent',
    });
  });

  it('is UNREADABLE only for program-owned bytes that fail to decode', () => {
    expect(
      readPlanAccount({ owner: SUBSCRIPTIONS_PROGRAM_ID, lamports: RENT, dataBase64: 'AAAA' }),
    ).toEqual({ state: 'unreadable' });
  });

  it('decodes a program-owned plan', () => {
    expect(
      readPlanAccount({
        owner: SUBSCRIPTIONS_PROGRAM_ID,
        lamports: RENT,
        dataBase64: encodePlanAccountForTests(PLAN),
      }),
    ).toEqual({ state: 'present', account: PLAN });
  });
});

describe('decodeSubscriptionAccount', () => {
  const SUBSCRIPTION: OnchainSubscriptionAccount = {
    subscriber: '11111111111111111111111111111116',
    planAddress: '11111111111111111111111111111117',
    rentPayer: '11111111111111111111111111111118',
    initId: 7n,
    amount: 5_000_000n,
    periodHours: 168,
    termsCreatedAt: 1_690_000_000n,
    amountPulledInPeriod: 1_000_000n,
    currentPeriodStartTs: 1_695_000_000n,
    expiresAtTs: 1_700_000_000n,
  };

  function encodeSubscriptionAccountForTests(subscription: OnchainSubscriptionAccount): string {
    const bytes = getSubscriptionDelegationEncoder().encode({
      header: {
        discriminator: 4, // SubscriptionDelegation
        version: 1,
        bump: 255,
        delegator: subscription.subscriber as never,
        delegatee: subscription.planAddress as never,
        payer: subscription.rentPayer as never,
        initId: subscription.initId,
      },
      terms: {
        amount: subscription.amount,
        periodHours: BigInt(subscription.periodHours),
        createdAt: subscription.termsCreatedAt,
      },
      amountPulledInPeriod: subscription.amountPulledInPeriod,
      currentPeriodStartTs: subscription.currentPeriodStartTs,
      expiresAtTs: subscription.expiresAtTs,
    } as never);
    return Buffer.from(bytes as Uint8Array).toString('base64');
  }

  it('round-trips every field distinctly — a subscriber/planAddress swap would fail this', () => {
    // Every field of SUBSCRIPTION is a different value, so a field-path swap anywhere in
    // decodeSubscriptionAccount (e.g. subscriber/planAddress, or amountPulledInPeriod/amount)
    // changes the result and this exact equality catches it.
    const decoded = decodeSubscriptionAccount(encodeSubscriptionAccountForTests(SUBSCRIPTION));
    expect(decoded).toEqual(SUBSCRIPTION);
  });

  it('returns null for anything the wrong size', () => {
    expect(decodeSubscriptionAccount('AQID')).toBeNull();
  });

  describe('readSubscriptionAccount (owner-aware)', () => {
    const valid = () => encodeSubscriptionAccountForTests(SUBSCRIPTION);

    it('is ABSENT when there is no account', () => {
      expect(readSubscriptionAccount(null)).toEqual({ state: 'absent' });
    });

    it('is ABSENT for an empty System-owned account — a closed PDA someone sent lamports to', () => {
      // Anyone can fund a closed address; that must read as "gone", never as "unreadable".
      expect(
        readSubscriptionAccount({ owner: SYSTEM_PROGRAM, lamports: RENT, dataBase64: '' }),
      ).toEqual({ state: 'absent' });
    });

    it('is ABSENT for well-formed bytes under ANY other owner: only the program can vouch for them', () => {
      expect(
        readSubscriptionAccount({ owner: SYSTEM_PROGRAM, lamports: RENT, dataBase64: valid() }),
      ).toEqual({ state: 'absent' });
    });

    it('is ABSENT for a program-owned account with zero-length data', () => {
      expect(
        readSubscriptionAccount({ owner: SUBSCRIPTIONS_PROGRAM_ID, lamports: RENT, dataBase64: '' }),
      ).toEqual({ state: 'absent' });
    });

    it('is UNREADABLE only for program-owned bytes that fail to decode', () => {
      expect(
        readSubscriptionAccount({ owner: SUBSCRIPTIONS_PROGRAM_ID, lamports: RENT, dataBase64: 'AAAA' }),
      ).toEqual({ state: 'unreadable' });
    });

    it('decodes a program-owned account', () => {
      expect(
        readSubscriptionAccount({ owner: SUBSCRIPTIONS_PROGRAM_ID, lamports: RENT, dataBase64: valid() }),
      ).toEqual({ state: 'present', account: SUBSCRIPTION });
    });
  });

  it('returns null for a right-sized account with the wrong discriminator', () => {
    const bytes = Buffer.from(encodeSubscriptionAccountForTests(SUBSCRIPTION), 'base64');
    bytes[0] = 1; // Plan, not SubscriptionDelegation
    expect(decodeSubscriptionAccount(bytes.toString('base64'))).toBeNull();
  });
});

describe('decodeAuthorityAccount', () => {
  const AUTHORITY: OnchainAuthorityAccount = {
    user: '11111111111111111111111111111119',
    tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    initId: 99n,
    bump: 254,
  };
  /** Rent payer is part of the on-chain layout but not of OnchainAuthorityAccount — distinct
   *  from every AUTHORITY field so it can never be mistaken for one of them if a future
   *  field-path bug leaks it through. */
  const RENT_PAYER = '11111111111111111111111111111112';

  function encodeAuthorityAccountForTests(authority: OnchainAuthorityAccount): string {
    const bytes = getSubscriptionAuthorityEncoder().encode({
      discriminator: 0, // SubscriptionAuthority
      user: authority.user as never,
      tokenMint: authority.tokenMint as never,
      payer: RENT_PAYER as never,
      bump: authority.bump,
      initId: authority.initId,
    } as never);
    return Buffer.from(bytes as Uint8Array).toString('base64');
  }

  it('round-trips every field distinctly — a user/tokenMint swap would fail this', () => {
    const decoded = decodeAuthorityAccount(encodeAuthorityAccountForTests(AUTHORITY));
    expect(decoded).toEqual(AUTHORITY);
  });

  it('returns null for anything the wrong size', () => {
    expect(decodeAuthorityAccount('AQID')).toBeNull();
  });

  it('returns null for a right-sized account with the wrong discriminator', () => {
    const bytes = Buffer.from(encodeAuthorityAccountForTests(AUTHORITY), 'base64');
    bytes[0] = 1; // Plan, not SubscriptionAuthority
    expect(decodeAuthorityAccount(bytes.toString('base64'))).toBeNull();
  });

  describe('readAuthorityAccount (owner-aware)', () => {
    it('is ABSENT when missing, not program-owned, or empty', () => {
      expect(readAuthorityAccount(null)).toEqual({ state: 'absent' });
      expect(
        readAuthorityAccount({
          owner: SYSTEM_PROGRAM,
          lamports: RENT,
          dataBase64: encodeAuthorityAccountForTests(AUTHORITY),
        }),
      ).toEqual({ state: 'absent' });
      expect(
        readAuthorityAccount({ owner: SUBSCRIPTIONS_PROGRAM_ID, lamports: RENT, dataBase64: '' }),
      ).toEqual({ state: 'absent' });
    });

    it('is UNREADABLE for program-owned bytes that do not decode', () => {
      expect(
        readAuthorityAccount({ owner: SUBSCRIPTIONS_PROGRAM_ID, lamports: RENT, dataBase64: 'AAAA' }),
      ).toEqual({ state: 'unreadable' });
    });

    it('is PRESENT with the decoded authority', () => {
      expect(
        readAuthorityAccount({
          owner: SUBSCRIPTIONS_PROGRAM_ID,
          lamports: RENT,
          dataBase64: encodeAuthorityAccountForTests(AUTHORITY),
        }),
      ).toEqual({ state: 'present', account: AUTHORITY });
    });
  });
});
