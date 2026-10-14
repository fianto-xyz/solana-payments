import { getSolanaErrorFromJsonRpcError } from '@solana/kit';
import { isPreflightInstructionFailure } from './preflight-failure.js';

/** A preflight rejection exactly as the RPC client builds it from the JSON-RPC error body. */
const preflight = (err: unknown) =>
  getSolanaErrorFromJsonRpcError({
    code: -32002,
    message: 'Transaction simulation failed',
    data: { err, accounts: null, logs: [], unitsConsumed: 0 },
  });

describe('isPreflightInstructionFailure', () => {
  it('is true for a simulation that failed inside an instruction', () => {
    expect(isPreflightInstructionFailure(preflight({ InstructionError: [1, { Custom: 1 }] }))).toBe(true);
    expect(isPreflightInstructionFailure(preflight({ InstructionError: [0, 'InvalidAccountData'] }))).toBe(true);
  });

  // The runtime raises this AFTER executing, so a leader can include it as FAILED and charge
  // the payer the fee — exactly what the rule prevents for an instruction error. It cannot do
  // what it was built for against the current state either.
  it('is true for a simulation that would leave an account below rent exemption', () => {
    expect(isPreflightInstructionFailure(preflight({ InsufficientFundsForRent: { account_index: 0 } }))).toBe(true);
    expect(isPreflightInstructionFailure(preflight({ InsufficientFundsForRent: { account_index: 2 } }))).toBe(true);
  });

  // AlreadyProcessed means the payer's wallet already broadcast it — it LANDED and moved the
  // money; BlockhashNotFound can be a lagging node. Neither may ever make a caller stop treating it as live.
  it.each(['AlreadyProcessed', 'BlockhashNotFound', 'InsufficientFundsForFee'])(
    'is false for the transaction-level error %s',
    (err) => {
      expect(isPreflightInstructionFailure(preflight(err))).toBe(false);
    },
  );

  it('is false for anything that is not a preflight failure', () => {
    expect(isPreflightInstructionFailure(new TypeError('fetch failed'))).toBe(false);
    expect(isPreflightInstructionFailure(new Error('503 from the provider'))).toBe(false);
    expect(isPreflightInstructionFailure(null)).toBe(false);
    expect(
      isPreflightInstructionFailure(
        getSolanaErrorFromJsonRpcError({ code: -32005, message: 'Node is unhealthy', data: {} }),
      ),
    ).toBe(false);
  });
});
