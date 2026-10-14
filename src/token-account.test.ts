import { AccountState, getTokenEncoder } from '@solana-program/token';
import { getBase64Decoder, type Address } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from './solana.constants.js';
import { tokenAccountFrom } from './token-account.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OWNER = 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse';

const encoded = (state: AccountState) =>
  getBase64Decoder().decode(
    getTokenEncoder().encode({
      mint: MINT as Address,
      owner: OWNER as Address,
      amount: 12_500_000n,
      delegate: null,
      state,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
    }),
  );

describe('tokenAccountFrom', () => {
  it('decodes a token-program account', () => {
    expect(
      tokenAccountFrom({ owner: TOKEN_PROGRAM_ADDRESS, lamports: 1n, dataBase64: encoded(AccountState.Initialized) }, TOKEN_PROGRAM_ADDRESS),
    ).toEqual({ mint: MINT, owner: OWNER, amount: 12_500_000n, isFrozen: false });
    expect(
      tokenAccountFrom({ owner: TOKEN_PROGRAM_ADDRESS, lamports: 1n, dataBase64: encoded(AccountState.Frozen) }, TOKEN_PROGRAM_ADDRESS)?.isFrozen,
    ).toBe(true);
  });

  it('is null for a missing account, another program, or a wallet', () => {
    expect(tokenAccountFrom(null, TOKEN_PROGRAM_ADDRESS)).toBeNull();
    expect(
      tokenAccountFrom({ owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', lamports: 1n, dataBase64: encoded(AccountState.Initialized) }, TOKEN_PROGRAM_ADDRESS),
    ).toBeNull();
    expect(tokenAccountFrom({ owner: '11111111111111111111111111111111', lamports: 5n, dataBase64: '' }, TOKEN_PROGRAM_ADDRESS)).toBeNull();
  });
});
