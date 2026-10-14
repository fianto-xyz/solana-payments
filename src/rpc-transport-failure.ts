import {
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
  SOLANA_ERROR__JSON_RPC__INVALID_REQUEST,
  SOLANA_ERROR__JSON_RPC__PARSE_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_NOT_EPOCH_BOUNDARY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_PRECOMPILE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_LEN_MISMATCH,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type RpcTransport,
} from '@solana/kit';
import { SolanaRpcBusyError } from './rpc.js';

/**
 * The JSON-RPC error codes that ARE an answer: the node is up and
 * says something about the request or the transaction — a preflight/simulation verdict
 * (BlockhashNotFound, AlreadyProcessed and instruction errors all arrive as -32002), a signature
 * or version the node refuses, a slot it says was skipped, a malformed request. A second
 * provider would say the same, and callers interpret these, so they propagate unchanged.
 *
 * EVERY OTHER code means "this provider cannot answer right now", never "the chain says no":
 * -32603 internal error, -32005 node unhealthy, -32011 no transaction history, -32004/-32014/
 * -32016 lagging, -32601 a method the endpoint does not offer, and every code outside Solana's list
 * — -32000 Unauthorized, -32029 Too Many Requests, 429/403 in the body. An
 * allow-list of answers, not a deny-list of outages, so an unknown code can only ever cost a
 * retry, never a wrong verdict.
 */
const ANSWER_CODES: ReadonlySet<number> = new Set([
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_PRECOMPILE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_LEN_MISMATCH,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_NOT_EPOCH_BOUNDARY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND,
  SOLANA_ERROR__JSON_RPC__INVALID_REQUEST,
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
  SOLANA_ERROR__JSON_RPC__PARSE_ERROR,
]);

/** Whether a JSON-RPC error code (from a response body) means the provider did not answer. */
export function providerCannotAnswer(code: number): boolean {
  return !ANSWER_CODES.has(code);
}

/**
 * A provider that answered HTTP 200 with a JSON-RPC error meaning it cannot answer (see
 * `ANSWER_CODES`), or with a body that is not JSON at all. Raised by `withProviderRefusals`
 * BEFORE kit builds its own error from the body, so it is the same object whatever NODE_ENV is:
 * kit's own error for an unknown code is a `SolanaError` under `production` but a
 * `TypeError` out of its message formatter everywhere else. Carries the code, never the
 * provider's message (it can be long, and may echo request details).
 */
export class RpcProviderRefusedError extends Error {
  constructor(readonly code: number | null) {
    super(code === null ? 'The RPC provider sent a body that is not JSON' : `JSON-RPC error ${code}`);
    this.name = 'RpcProviderRefusedError';
  }
}

function jsonRpcErrorCode(response: unknown): number | null {
  if (typeof response !== 'object' || response === null || !('error' in response)) return null;
  const { error } = response as { error: unknown };
  if (typeof error !== 'object' || error === null) return Number.NaN;
  const code = Number((error as { code?: unknown }).code);
  return code;
}

/**
 * Wraps the HTTP transport so a provider's in-band refusal never reaches kit's error builder.
 * Answers (`ANSWER_CODES`) and results pass through untouched, as does every error the
 * transport itself throws (HTTP status, timeout, fetch failure) — `isTransportFailure` already
 * classifies those.
 */
export function withProviderRefusals(transport: RpcTransport): RpcTransport {
  return (async (config: Parameters<RpcTransport>[0]) => {
    let response: unknown;
    try {
      response = await transport(config);
    } catch (error) {
      // HTTP 200 with an HTML page or a truncated body: `response.json()` fails. No answer.
      if (error instanceof SyntaxError) throw new RpcProviderRefusedError(null);
      throw error;
    }
    const code = jsonRpcErrorCode(response);
    if (code !== null && (Number.isNaN(code) || providerCannotAnswer(code))) {
      throw new RpcProviderRefusedError(Number.isNaN(code) ? null : code);
    }
    return response;
  }) as RpcTransport;
}

/** Node's fetch (undici) error codes for a connection that failed, by `cause.code`. */
const NETWORK_ERROR_CODE = /^(UND_ERR_|E[A-Z]+$)/;

/**
 * A `TypeError` that fetch itself threw: undici's `TypeError('fetch failed')` (its
 * `cause` names the network error) or `TypeError('terminated')` for a body cut off mid-read.
 * Any other TypeError is a bug — the caller's, or a library's — and must surface as one, never
 * be classified as "the provider did not answer".
 */
function isFetchTypeError(error: TypeError): boolean {
  if (error.message === 'fetch failed' || error.message === 'terminated') return true;
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && NETWORK_ERROR_CODE.test(code);
}

/**
 * Whether the SAME request is worth sending again — later, or to another endpoint: this
 * endpoint never gave an answer. True for a failed connection, a client-side timeout, an HTTP error status, and an
 * in-band JSON-RPC error that is not an answer (`withProviderRefusals`; kit's own `SolanaError`
 * for such a code too, for a client built without the wrapper). False for a JSON-RPC error that
 * IS an answer (`ANSWER_CODES`) — any other endpoint would say the same — and for anything else,
 * which is a bug to surface.
 */
export function isTransportFailure(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'TimeoutError' || error.name === 'AbortError';
  }
  if (error instanceof RpcProviderRefusedError) return true;
  if (error instanceof TypeError) return isFetchTypeError(error);
  if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return true;
  if (isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY)) return true;
  if (!isSolanaError(error)) return false;
  // Only codes in JSON-RPC's own range are a provider's; kit's own codes are positive.
  const code = error.context.__code;
  return code <= -32_000 && code >= -32_768 && providerCannotAnswer(code);
}

/**
 * Raise this when none of the RPC endpoints a caller asked answered at all. It is distinct
 * from every answer, including a negative one: the caller has no information to act on, so
 * it should retry, and never conclude from it that a transaction landed or was dropped.
 */
export class SolanaProviderUnavailableError extends Error {
  constructor(message = 'No configured Solana RPC provider answered.') {
    super(message);
    this.name = 'SolanaProviderUnavailableError';
  }
}

/**
 * Whether an error that reached an HTTP answer means "Solana cannot be asked right now":
 * a provider that did not answer (isTransportFailure: an HTTP 429 or 5xx, an in-band refusal
 * such as -32029 Too Many Requests, a client-side timeout), no provider answering at all, or the
 * caller's own RPC rate limit out of reach. The request may be retried as it is.
 */
export function isRpcUnavailable(error: unknown): boolean {
  return (
    error instanceof SolanaProviderUnavailableError || error instanceof SolanaRpcBusyError || isTransportFailure(error)
  );
}

/** The error's name, plus the code for a provider refusal — for a log line, never the message. */
export function describeRpcFailure(error: unknown): string {
  if (error instanceof RpcProviderRefusedError) {
    return error.code === null ? error.name : `${error.name} ${error.code}`;
  }
  return (error as Error).name;
}
