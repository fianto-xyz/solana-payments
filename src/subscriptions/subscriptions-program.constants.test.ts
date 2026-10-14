import {
  AUTHORITY_ACCOUNT_BYTES,
  PLAN_ACCOUNT_BYTES,
  SUBSCRIPTION_ACCOUNT_BYTES,
} from './subscriptions-program.constants.js';

describe('the pinned account sizes', () => {
  it('match the SDK-exported sizes', () => {
    expect(PLAN_ACCOUNT_BYTES).toBe(491);
    expect(SUBSCRIPTION_ACCOUNT_BYTES).toBe(155);
    expect(AUTHORITY_ACCOUNT_BYTES).toBe(106);
  });
});

// No rent constants any more: rent per byte is a cluster parameter that has changed (see
// `getMinimumBalanceForRentExemption`), so the quote is always the cluster's own answer.
