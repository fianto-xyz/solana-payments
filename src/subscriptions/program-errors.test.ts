import {
  programErrorCodeOf,
  programErrorMessage,
  SUBSCRIPTION_PROGRAM_ERRORS,
} from './program-errors.js';

describe('programErrorCodeOf', () => {
  it('reads the instruction index and the custom code out of a landed error', () => {
    expect(programErrorCodeOf({ InstructionError: [3, { Custom: 400 }] })).toEqual({
      instructionIndex: 3,
      code: 400,
    });
  });

  // What a REAL cluster returns: @solana/kit parses every JSON number in `err` as a bigint.
  // Observed on solana-test-validator 4.0.1 against the mainnet program:
  // `{ InstructionError: [2n, { Custom: 400n }] }`. A hand-built error uses plain numbers.
  it('reads the bigint shape a real RPC returns', () => {
    expect(programErrorCodeOf({ InstructionError: [2n, { Custom: 400n }] })).toEqual({
      instructionIndex: 2,
      code: 400,
    });
    expect(programErrorCodeOf({ InstructionError: [4n, { Custom: 1n }] })).toEqual({
      instructionIndex: 4,
      code: 1,
    });
  });

  it.each([
    ['a negative bigint custom code', { InstructionError: [0n, { Custom: -5n }] }],
    ['a negative bigint instruction index', { InstructionError: [-1n, { Custom: 400n }] }],
    ['a bigint code past u32', { InstructionError: [0n, { Custom: 2n ** 32n }] }],
    ['a bigint index past u8', { InstructionError: [256n, { Custom: 400n }] }],
  ])('returns null for %s', (_label, err) => {
    expect(programErrorCodeOf(err)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'BlockhashNotFound'],
    ['a non-custom instruction error', { InstructionError: [0, 'InvalidAccountData'] }],
    ['a malformed tuple', { InstructionError: [0] }],
    ['a nested object of the wrong shape', { InstructionError: [0, { Other: 1 }] }],
    ['a NaN custom code', { InstructionError: [0, { Custom: NaN }] }],
    ['a negative custom code', { InstructionError: [0, { Custom: -5 }] }],
    ['a fractional custom code', { InstructionError: [0, { Custom: 1.5 }] }],
    ['a negative instruction index', { InstructionError: [-1, { Custom: 400 }] }],
    ['a fractional instruction index', { InstructionError: [1.5, { Custom: 400 }] }],
  ])('returns null for %s', (_label, err) => {
    expect(programErrorCodeOf(err)).toBeNull();
  });
});

describe('the pinned error codes', () => {
  it('matches the numbers the program declares — all sixteen', () => {
    // Every entry SUBSCRIPTION_PROGRAM_ERRORS carries, not a subset: a renumbering of any one
    // is a failing assertion, not silent.
    expect(SUBSCRIPTION_PROGRAM_ERRORS).toEqual({
      NOT_SIGNER: 100,
      INVALID_DELEGATE_PDA: 126,
      DELEGATION_EXPIRED: 128,
      UNAUTHORIZED: 130,
      STALE_SUBSCRIPTION_AUTHORITY: 136,
      AMOUNT_EXCEEDS_PERIOD_LIMIT: 400,
      DELEGATION_NOT_STARTED: 407,
      PLAN_SUNSET: 500,
      PLAN_EXPIRED: 501,
      NOT_PLAN_OWNER: 504,
      UNAUTHORIZED_DESTINATION: 506,
      SUBSCRIPTION_CANCELLED: 508,
      ALREADY_SUBSCRIBED: 517,
      PLAN_ALREADY_EXISTS: 518,
      PLAN_TERMS_MISMATCH: 519,
      STALE_PLAN_APPROVAL: 522,
    });
  });

  /**
   * The SDK's own message for each pinned code, copied from its (private) message table —
   * NOT derived from `programErrorMessage` itself, so this cannot become circular. Distinct
   * per code on purpose: `programErrorMessage`'s fallback ("Unknown subscriptions program
   * error <code>") is non-empty for ANY number, so a length-only assertion can never fail —
   * exact-string equality against a table built independently of the code under test is what
   * makes a renumbering (e.g. DELEGATION_EXPIRED 128 → 407, a live code with its own message)
   * show up as a real failure instead of two different codes both satisfying "has a message".
   */
  const EXPECTED_MESSAGE: Record<keyof typeof SUBSCRIPTION_PROGRAM_ERRORS, string> = {
    NOT_SIGNER: 'Account must be a signer',
    INVALID_DELEGATE_PDA: 'Invalid delegation PDA derivation',
    DELEGATION_EXPIRED: 'Delegation has expired',
    UNAUTHORIZED: 'Caller not authorized for this action',
    STALE_SUBSCRIPTION_AUTHORITY: 'Delegation init_id does not match current SubscriptionAuthority',
    AMOUNT_EXCEEDS_PERIOD_LIMIT: 'Transfer amount exceeds period limit',
    DELEGATION_NOT_STARTED: 'Delegation period has not started yet',
    PLAN_SUNSET: 'Plan is in sunset status',
    PLAN_EXPIRED: 'Plan has expired',
    NOT_PLAN_OWNER: 'Caller is not the plan owner',
    UNAUTHORIZED_DESTINATION: 'Destination not in plan whitelist',
    SUBSCRIPTION_CANCELLED: 'Subscription cancelled and past valid period',
    ALREADY_SUBSCRIBED: 'Already subscribed to this plan',
    PLAN_ALREADY_EXISTS: 'Plan account already exists',
    PLAN_TERMS_MISMATCH: 'Subscription plan terms do not match the current plan',
    STALE_PLAN_APPROVAL: 'Plan update approval does not match the current plan state',
  };

  it('resolves each pinned code to its own distinct SDK message, never the fallback', () => {
    for (const [name, code] of Object.entries(SUBSCRIPTION_PROGRAM_ERRORS) as [
      keyof typeof SUBSCRIPTION_PROGRAM_ERRORS,
      number,
    ][]) {
      expect(programErrorMessage(code)).toBe(EXPECTED_MESSAGE[name]);
    }
    // Every expected message is unique, so a code-to-code mixup (not just a fallback) would
    // also be caught by the loop above — this just proves the fixture itself has no collision.
    expect(new Set(Object.values(EXPECTED_MESSAGE)).size).toBe(
      Object.keys(EXPECTED_MESSAGE).length,
    );
  });

  it('falls back to a safe generic message for a code it does not pin', () => {
    expect(programErrorMessage(999_999)).toBe('Unknown subscriptions program error 999999');
  });
});

describe('programErrorMessage for a token-program code', () => {
  it("names an SPL Token error the program's CPI returned, never 'Unknown subscriptions program error'", () => {
    // A pull after the payer revoked the approval: the token program's OwnerMismatch.
    expect(programErrorMessage(4)).toBe('SPL Token error 4: Owner does not match');
    expect(programErrorMessage(17)).toBe('SPL Token error 17: Account is frozen');
    // The program's own codes start at 100 and keep their own messages.
    expect(programErrorMessage(SUBSCRIPTION_PROGRAM_ERRORS.DELEGATION_EXPIRED)).toBe('Delegation has expired');
    expect(programErrorMessage(99)).toBe('Unknown program error 99');
  });
});
