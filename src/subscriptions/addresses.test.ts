import {
  deriveEventAuthorityAddress,
  derivePlanAddress,
  deriveSubscriptionAddress,
  deriveSubscriptionAuthorityAddress,
  SUBSCRIPTIONS_PROGRAM_ID,
  SUBSCRIPTIONS_ZERO_ADDRESS,
  UNKNOWN_INIT_ID,
} from './addresses.js';

const OWNER = '11111111111111111111111111111112';
const PAYER = 'So11111111111111111111111111111111111111112';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('the Subscriptions program addresses', () => {
  it('pins the program id and the empty-slot address', () => {
    expect(SUBSCRIPTIONS_PROGRAM_ID).toBe('De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44');
    expect(SUBSCRIPTIONS_ZERO_ADDRESS).toBe('11111111111111111111111111111111');
  });

  it('pins the sentinel a new authority is created with', () => {
    expect(UNKNOWN_INIT_ID).toBe(-9223372036854775808n);
  });

  it('derives a plan address from (owner, planId) and nothing else', async () => {
    const first = await derivePlanAddress(OWNER, 42n);
    const again = await derivePlanAddress(OWNER, 42n);
    const other = await derivePlanAddress(OWNER, 43n);
    // Golden vector, independently re-derived with kit's getProgramDerivedAddress from the
    // SDK's own PLAN_SEED ("plan") against ["plan", owner, u64le(planId)] — pins the exact
    // seed ROLES (owner first, planId second) and the program id, not just determinism. A
    // swapped or reordered seed pair would produce a different address here.
    expect(first.address).toBe('6WNndzYZhJJbzbc1vwRr95fW5T9cSHSeGuL7bRzFi269');
    expect(first.bump).toBe(252);
    expect(first.address).toBe(again.address);
    expect(first.bump).toBe(again.bump);
    expect(first.address).not.toBe(other.address);
  });

  it('derives ONE authority per payer per mint, whatever the plan, from the right seed roles', async () => {
    const authority = await deriveSubscriptionAuthorityAddress(PAYER, MINT);
    const same = await deriveSubscriptionAuthorityAddress(PAYER, MINT);
    // Golden vector, independently re-derived against ["SubscriptionAuthority", payer, mint].
    // A swapped (mint, payer) pair — the exact failure mode a determinism-only assertion
    // cannot see — produces a DIFFERENT address ('7kV7KJXrfj3k5pzp3HoLHyRjzG5mbBvt7ioL82sJUZfT'),
    // so pinning the real one below is what actually proves payer-first, mint-second.
    expect(authority.address).toBe('AUCENQvmGf9PX86QEfDaioWPmfsvLujYomRjVh64Pt4b');
    expect(authority.bump).toBe(255);
    expect(authority.address).toBe(same.address);
  });

  it('derives one subscription per (plan, payer), from the right seed roles', async () => {
    const plan = await derivePlanAddress(OWNER, 42n);
    const other = await derivePlanAddress(OWNER, 43n);
    const a = await deriveSubscriptionAddress(plan.address, PAYER);
    const b = await deriveSubscriptionAddress(other.address, PAYER);
    // Golden vector, independently re-derived against ["subscription", planPda, subscriber] —
    // pins planAddress-first, payerWallet-second (a swap would derive a different address).
    expect(a.address).toBe('9iaSW6toLbcGsusUxSQKbRpfNmZhrLoScRpSEw7WanNZ');
    expect(a.bump).toBe(255);
    expect(a.address).not.toBe(b.address);
    expect((await deriveSubscriptionAddress(plan.address, PAYER)).address).toBe(a.address);
  });

  it('derives the event authority with no arguments', async () => {
    const eventAuthority = await deriveEventAuthorityAddress();
    expect(eventAuthority).toBe('3Hnj4BYoDgtpBuqXfiy7Y8cNa3jXaNd4oqgSXBzkMcH7');
    expect(eventAuthority).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});
