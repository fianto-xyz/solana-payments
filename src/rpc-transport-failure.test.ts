import { readFileSync } from 'node:fs';
import {
  createSolanaRpcFromTransport,
  getSolanaErrorFromJsonRpcError,
  SolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type RpcTransport,
} from '@solana/kit';
import { isTransportFailure, withProviderRefusals } from './rpc-transport-failure.js';

describe('isTransportFailure', () => {
  it('is true for a fetch that never connected', () => {
    expect(isTransportFailure(new TypeError('fetch failed'))).toBe(true);
    // undici names the network error in `cause`.
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8899'), { code: 'ECONNREFUSED' });
    expect(isTransportFailure(new TypeError('fetch failed', { cause: refused }))).toBe(true);
    const socket = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    expect(isTransportFailure(new TypeError('terminated', { cause: socket }))).toBe(true);
  });

  // Every TypeError used to count as "the provider did not answer", so a bug in the caller's
  // own code (or a library's) moved to the fallback, or read as "silent", instead of surfacing.
  it('is false for a TypeError that is a bug, not the network', () => {
    expect(isTransportFailure(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isTransportFailure(new TypeError("Cannot read properties of undefined (reading 'length')"))).toBe(false);
  });

  it('is true for a client-side timeout', () => {
    expect(isTransportFailure(new DOMException('timed out', 'TimeoutError'))).toBe(true);
    expect(isTransportFailure(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('is true for an HTTP error from the provider', () => {
    expect(
      isTransportFailure(
        new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
          headers: new Headers(),
          message: 'Bad gateway',
          statusCode: 502,
        }),
      ),
    ).toBe(true);
  });

  it('is true when the node reports itself unhealthy', () => {
    expect(
      isTransportFailure(
        new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY, {
          numSlotsBehind: 42,
        }),
      ),
    ).toBe(true);
  });

  it('is false for an answer the node actually gave', () => {
    // A real JSON-RPC error means the node is up and disagrees. Asking a second provider
    // the same question would get the same answer and burn the budget.
    expect(isTransportFailure(new Error('Invalid param: not a Token account'))).toBe(false);
  });
});

/** A JSON-RPC error inside an HTTP 200 becomes a different error in kit depending on NODE_ENV — under `production` a `SolanaError` carrying the code; anywhere else, for a code kit has no message for, a `TypeError` from its message formatter. These run each body (testdata/devnet-rpc-errors.json) through kit in every mode. */
describe('in-band JSON-RPC errors, whatever NODE_ENV is', () => {
  const bodies = JSON.parse(
    readFileSync(new URL('./testdata/devnet-rpc-errors.json', import.meta.url), 'utf8'),
  ) as Record<string, { body: { error: { code: number } } }>;
  const NO_ANSWER = [
    'unauthorized_-32000',
    'internal_-32603',
    'node_behind_-32005',
    'rate_limited_429_in_body',
    'rate_limited_-32029_in_body',
    'history_unavailable_-32011',
  ];
  const ANSWERS = ['unsupported_version_-32015', 'blockhash_not_found_-32002', 'invalid_params_-32602'];
  const MODES = ['production', 'development', 'test'] as const;
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  /** A real kit RPC client over a transport that answers HTTP 200 with `body`. */
  function rpcAnswering(body: unknown) {
    const transport = (({ payload }: { payload: { id: unknown } }) =>
      Promise.resolve({ ...(body as object), id: payload.id })) as RpcTransport;
    return createSolanaRpcFromTransport(withProviderRefusals(transport));
  }

  for (const mode of MODES) {
    it.each(NO_ANSWER)(`NODE_ENV=${mode}: %s is "the provider did not answer"`, async (name) => {
      process.env.NODE_ENV = mode;
      const error = await rpcAnswering(bodies[name].body).getSlot().send().catch((e: unknown) => e);
      expect(isTransportFailure(error)).toBe(true);
    });

    it.each(ANSWERS)(`NODE_ENV=${mode}: %s is an answer, never an outage`, async (name) => {
      process.env.NODE_ENV = mode;
      const error = await rpcAnswering(bodies[name].body).getSlot().send().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(isTransportFailure(error)).toBe(false);
    });
  }

  // The same JSON-RPC codes, as the SolanaError kit itself builds under production (a client
  // built without the wrapper): classified by code, not by how kit chose to word it.
  it.each(['unauthorized_-32000', 'internal_-32603', 'rate_limited_-32029_in_body', 'history_unavailable_-32011'])(
    "kit's own production-mode error for %s is \"the provider did not answer\"",
    (name) => {
      process.env.NODE_ENV = 'production';
      expect(isTransportFailure(getSolanaErrorFromJsonRpcError(bodies[name].body.error))).toBe(true);
    },
  );

  it('passes a result through untouched', async () => {
    const result = await rpcAnswering({ jsonrpc: '2.0', result: 506_479_059 }).getSlot().send();
    expect(result).toBe(506_479_059n);
  });
});
