import {
  isSolanaError,
  SOLANA_ERROR__INSTRUCTION_ERROR__UNKNOWN,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_RENT,
} from '@solana/kit';

/** Every instruction-error code the RPC client produces lies in [UNKNOWN, UNKNOWN + 1000). */
const INSTRUCTION_ERROR_CODES_END = SOLANA_ERROR__INSTRUCTION_ERROR__UNKNOWN + 1_000;

/**
 * Whether a send was rejected by PREFLIGHT because the simulation failed INSIDE an instruction
 * (insufficient funds, a program error) — or because executing it would
 * leave an account below rent exemption (`InsufficientFundsForRent`). That transaction cannot do what it was built for against the current state, and
 * the runtime raises both AFTER executing it, so rebroadcasting it with preflight off only lets
 * a leader include it as FAILED and charge the payer a network fee. (The payer could top up and
 * make it succeed — as for an instruction error's empty token account; the rule is the state
 * NOW, and the payer can simply try again.)
 *
 * Deliberately false for every transaction-level preflight error. `AlreadyProcessed` means the
 * payer's wallet already broadcast it: it LANDED and moved the money. `BlockhashNotFound` can be
 * a lagging node. Neither says anything about the outcome, and a caller must never treat this
 * as one either: it may only stop a rebroadcast; the chain still decides.
 */
export function isPreflightInstructionFailure(error: unknown): boolean {
  if (!isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) {
    return false;
  }
  const cause = error.cause;
  if (!isSolanaError(cause)) return false;
  const code = cause.context.__code;
  if (code === SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_RENT) return true;
  return code >= SOLANA_ERROR__INSTRUCTION_ERROR__UNKNOWN && code < INSTRUCTION_ERROR_CODES_END;
}
