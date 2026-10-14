import { isTransientTransactionError } from './transaction-errors.js';

describe('isTransientTransactionError', () => {
  it.each(['BlockhashNotFound', 'AccountInUse', 'WouldExceedMaxBlockCostLimit'])(
    'treats %s as transient',
    (err) => {
      expect(isTransientTransactionError(err)).toBe(true);
    },
  );

  it.each([
    ['a program failure', { InstructionError: [2, { Custom: 1 }] }],
    ['a built-in instruction error', { InstructionError: [2, 'InvalidAccountData'] }],
    ['an unrecognised string', 'AccountNotFound'],
    ['no error at all', null],
  ])('does not treat %s as transient', (_label, err) => {
    expect(isTransientTransactionError(err)).toBe(false);
  });
});
