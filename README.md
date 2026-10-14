# @fianto/solana-payments: USDC payments and subscriptions on Solana

**A TypeScript library, built on `@solana/kit`, that builds USDC payment and subscription transactions on Solana and lets you verify signed transactions a wallet sends back, before you broadcast or co-sign them.** It also renders and verifies Sign-In With Solana (SIWS) messages.

[![npm](https://img.shields.io/npm/v/@fianto/solana-payments)](https://www.npmjs.com/package/@fianto/solana-payments)
[![CI](https://github.com/fianto-xyz/solana-payments/actions/workflows/ci.yml/badge.svg)](https://github.com/fianto-xyz/solana-payments/actions/workflows/ci.yml)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@fianto/solana-payments)](https://bundlephobia.com/package/@fianto/solana-payments)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![TypeScript](https://img.shields.io/badge/types-included-blue)

Accepting a payment on Solana is easy. Making sure the wallet signed **exactly** the transaction
you built is not. This library builds the transaction and validates the signed bytes that come
back, instruction by instruction and byte for byte.

- **405 tests** (Vitest, `pnpm test`), run in CI on Node 22 and 24.
- **3 entry points:** `@fianto/solana-payments`, `/subscriptions` and `/money`.
- **4.2 kB** root entry, minified and brotli-compressed, peer dependencies excluded (`size-limit`).
- **0 runtime dependencies**; `@solana/kit` ^8.3 and the Solana program clients are peer dependencies.
- ESM and CommonJS, Node 22+, browsers and edge runtimes.

```bash
npm install @fianto/solana-payments @solana/kit @solana-program/token @solana-program/compute-budget
```

## 30-second example

```ts
import { buildPaymentTransaction, validateSignedPayment, deriveAssociatedTokenAddress, USDC_MINTS } from '@fianto/solana-payments';
import { parseUsdcAmount } from '@fianto/solana-payments/money';

declare const payerWallet: string, recipientWallet: string, reference: string, blockhash: string;
const mint = USDC_MINTS.devnet;

const expectation = {
  payerWallet,
  payerTokenAccount: await deriveAssociatedTokenAddress(payerWallet, mint),
  recipientTokenAccount: await deriveAssociatedTokenAddress(recipientWallet, mint),
  feeRecipientTokenAccount: null, // no fee
  mint, decimals: 6, amount: parseUsdcAmount('25.00')!, feeAmount: 0n,
  reference, blockhash,
};
const { base64 } = await buildPaymentTransaction({
  ...expectation, lastValidBlockHeight: 1_000n, computeUnitLimit: 60_000, computeUnitPriceMicroLamports: 1_000n,
});

// …send `base64` to the wallet, get the signed transaction back…
declare const signedBase64: string;
const result = await validateSignedPayment(signedBase64, expectation);
if (!result.ok) throw new Error(`refused: ${result.reason}`); // e.g. 'wrong_amount', 'unexpected_program'
```

A full, runnable version: [`examples/pay-usdc.ts`](examples/pay-usdc.ts). From a clone, `pnpm examples` builds the package and runs every example (Node 22.18+; no RPC, no funds needed).

## Why this library

Each section below answers one question and names the function that does it. Every refusal is
returned as `{ ok: false, reason }`, never thrown, so you can branch on the exact reason.

### How do I accept a USDC payment on Solana in TypeScript?

Build the transaction with `buildPaymentTransaction`, keep the expectation you built it from,
and check what the wallet signs with `validateSignedPayment` before you broadcast it. The
[30-second example](#30-second-example) shows the build step. The check:

```ts
import { validateSignedPayment, type PaymentExpectation } from '@fianto/solana-payments';

declare const signedBase64: string, expectation: PaymentExpectation;
const result = await validateSignedPayment(signedBase64, expectation);
if (result.ok) console.log('broadcast', result.signature);
else console.log('refused', result.reason);
```

The transaction is a legacy message: compute budget, one `transferChecked` to the recipient
carrying a read-only `reference` account (so the payment can be found by address later), and a
second transfer for a fee when the fee is above zero. The payer is the fee payer. Whether the
payment landed is a separate question: read the token-balance change on chain.

### How do I verify a signed Solana transaction before broadcasting it?

`validateSignedPayment` decodes the message and checks its meaning, not its bytes, since a wallet
may re-serialise what it signed. Each check refuses a real attack on "build a transaction, let
the wallet sign it":

| The returned transaction… | `reason` |
|---|---|
| calls a program other than Token and ComputeBudget | `unexpected_program` |
| carries a Token instruction that is not `transferChecked` | `unexpected_token_instruction` |
| adds, drops or redirects a transfer | `wrong_transfer_count` |
| changes an amount | `wrong_amount` |
| uses another mint or other decimals | `wrong_mint` |
| moves money from another account or authority | `wrong_source` |
| makes someone other than the payer pay the network fee | `wrong_fee_payer` |
| uses a blockhash other than the one you issued | `wrong_blockhash` |
| drops the reference account | `missing_reference` |
| carries signed bytes the message encoder would not produce | `trailing_bytes` |
| is a versioned (non-legacy) message | `not_legacy` |
| has no payer signature, or one that does not verify | `missing_signature`, `bad_signature` |

### How do I verify a signed transaction before co-signing it?

For a transaction a second party also signs (a subscription), an extra writable account or a
promoted signer role can cost the co-signer money. `validateSignedSubscribe` checks the exact
account list (`wrong_accounts`) and signer roles (`wrong_signers`) besides the instructions,
amounts, plan terms and destinations. After you add your signature, `verifyCoSignedTransaction`
checks that signing only added a signature:

```ts
import { verifyCoSignedTransaction } from '@fianto/solana-payments';

declare const payerSignedBase64: string, coSignedBase64: string, payerSignature: string, payerWallet: string;
const check = verifyCoSignedTransaction(coSignedBase64, {
  originalBase64: payerSignedBase64, signature: payerSignature, payerWallet,
});
if (!check.ok) throw new Error(check.reason); // 'message_changed', 'wrong_fee_payer', 'wrong_signature' or 'undecodable'
```

### How do I verify an Ed25519 wallet signature safely?

Some Ed25519 verifiers, including some WebCrypto builds, accept signatures from small-order and
non-canonical public keys that need no private key at all. `verifyWalletSignature` rejects those
keys itself, whatever the runtime does, and returns `false` instead of throwing for any
malformed input.

```ts
import { verifyWalletSignature } from '@fianto/solana-payments';

declare const wallet: string, message: string, signature: Uint8Array;
const valid = await verifyWalletSignature(wallet, message, signature); // boolean
```

### How do I do Sign-In With Solana (SIWS)?

`renderSiwsMessage` renders the SIWS text in the same order and format as the Wallet Standard's
`createSignInMessageText` when every field is supplied, so you can require the signed bytes to equal your own rendering.
`nonceOfSiwsMessage` reads the nonce out of a signed message so you can find the challenge you
issued, and `verifyWalletSignature` checks the signature. See the
[Sign-In With Solana recipe](#sign-in-with-solana) below.

```ts
import { nonceOfSiwsMessage } from '@fianto/solana-payments';

declare const signedMessage: string;
const nonce = nonceOfSiwsMessage(signedMessage); // null unless a `Nonce:` line of 8–64 letters and digits
```

### How do I build Solana subscriptions with the Subscriptions program?

The `/subscriptions` entry point wraps the [Solana Subscriptions program](https://www.npmjs.com/package/@solana/subscriptions)
(`@solana/subscriptions`, an optional peer dependency): `buildCreatePlanTransaction`,
`buildUpdatePlanPullersTransaction` and `buildSunsetPlanTransaction` for plans,
`buildSubscribeTransaction` and `validateSignedSubscribe` for the subscribe step,
`buildChargeTransaction` for later charges, `buildPayerActionTransaction` and
`validateSignedPayerAction` for a payer's cancel, revoke or re-authorize, plus account decoders,
address derivation and program error messages.

```ts
import { derivePlanAddress, programErrorMessage } from '@fianto/solana-payments/subscriptions';

declare const ownerWallet: string;
const plan = await derivePlanAddress(ownerWallet, 1n); // { address, bump }
console.log(programErrorMessage(130)); // the program's own text for error 130
```

### How do I tell an RPC outage from a failed transaction?

"The provider did not answer" and "the transaction failed" look alike in kit.
`isTransportFailure` and `describeRpcFailure` tell them apart in every `NODE_ENV`. See
[Retry only what is retryable](#retry-only-what-is-retryable).

## How it compares

What each package offers, from its README and exported functions, checked on 2026-10-14.
"—" means the package does not document or export it.

| | `@fianto/solana-payments` 0.1.0 | `@solana/kit` 8.3.0 (raw) | `@solana/pay` 1.0.26 | `@solana-commerce/solana-pay` 0.1.1 |
|---|---|---|---|---|
| Built on | `@solana/kit` ^8.3 (peer) | — | `@solana/kit` ^6.9 (peer) | `gill` ^0.10 (dependency) |
| Build a USDC transfer | `buildPaymentTransaction` (full transaction) | instruction and message primitives; you assemble it | `createTransfer` (returns instructions) | `createSplTransfer` (returns instructions) |
| Validate a signed transaction before broadcast, without RPC | `validateSignedPayment`, `validateSignedSubscribe`, `validateSignedPayerAction` | — | — | — |
| Validate a confirmed transaction over RPC | — | — | `validateTransfer`, `findReference` | — |
| Solana Pay URLs and QR codes | — | — | `encodeURL`, `parseURL`, `createQR` | `encodeURL`, `parseURL`, `createQR`, `createStyledQRCode` |
| Solana Pay transaction requests | — | — | `fetchTransaction` | `fetchTransaction`, `encodeTransactionRequestURL` |
| Ed25519 signature check | `verifyWalletSignature` (rejects small-order and non-canonical keys) | `verifySignature` (passes to WebCrypto) | — | — |
| SIWS message rendering | `renderSiwsMessage` | — | — | — |
| Solana Subscriptions program | `/subscriptions` | — | — | — |
| Amount type | `bigint` base units | `bigint` (lamports) | `number` | `bigint` |
| License | MIT | MIT | MIT | MIT (README) |

Use Solana Pay when you want the `solana:` URL scheme, QR codes and wallet interoperability
through that spec. Use this library when your server builds the transaction itself and must
check the signed bytes before it broadcasts or co-signs them. The two can sit side by side.

## What's inside

| Entry point | For |
|---|---|
| `@fianto/solana-payments` | One-time USDC payments (`buildPaymentTransaction`, `validateSignedPayment`, `verifyCoSignedTransaction`), Sign-In With Solana (`renderSiwsMessage`, `verifyWalletSignature`), RPC error classification, token-account helpers, `AccountBatcher` |
| `@fianto/solana-payments/subscriptions` | The [Solana Subscriptions program](https://www.npmjs.com/package/@solana/subscriptions): plan create/update/sunset, `subscribe` with validation, charges, payer cancel actions, account decoders, address derivation, program error messages |
| `@fianto/solana-payments/money` | USDC and SOL amounts as `bigint` (`parseUsdcAmount`, `formatUsdcAmount`, `formatSol`), basis-point fees (`computeFee`), percent formatting |

Every entry point is tree-shakeable (`"sideEffects": false`) and `/money` pulls in no Solana code.

## Recipes

### Sign-In With Solana

```ts
import { renderSiwsMessage, verifyWalletSignature, siwsChainId, SIWS_VERSION } from '@fianto/solana-payments';

declare const address: string, nonce: string, signature: Uint8Array;
const message = renderSiwsMessage({
  domain: 'app.example.com', address, statement: 'Sign in to Example.', uri: 'https://app.example.com',
  version: SIWS_VERSION, chainId: siwsChainId('mainnet-beta'), nonce,
  issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 300_000).toISOString(),
});
const ok = await verifyWalletSignature(address, message, signature);
```

Runnable: [`examples/sign-in-with-solana.ts`](examples/sign-in-with-solana.ts).

### Subscription accounts

```ts
import { derivePlanAddress, deriveSubscriptionAddress } from '@fianto/solana-payments/subscriptions';

declare const ownerWallet: string, payerWallet: string;
const plan = await derivePlanAddress(ownerWallet, 1n);
const subscription = await deriveSubscriptionAddress(plan.address, payerWallet);
```

Runnable: [`examples/subscription-accounts.ts`](examples/subscription-accounts.ts).

### Amounts without floats

```ts
import { parseUsdcAmount, formatUsdcAmount, computeFee } from '@fianto/solana-payments/money';

const amount = parseUsdcAmount('19.99'); // 19_990_000n, or null if malformed
const { feeAmount, totalAmount } = computeFee(amount!, 150); // 1.5% on top
console.log(formatUsdcAmount(totalAmount)); // "20.28985"
```

### Retry only what is retryable

```ts
import { isTransportFailure, describeRpcFailure } from '@fianto/solana-payments';

declare function sendToRpc(): Promise<void>;
try {
  await sendToRpc();
} catch (error) {
  if (isTransportFailure(error)) { /* the provider did not answer: retry, do not conclude anything */ }
  else console.error(describeRpcFailure(error));
}
```

## Compatibility

Node 22+, modern browsers and edge runtimes (WebCrypto only, no Node-only APIs; `verifyWalletSignature` needs a WebCrypto with Ed25519). ESM and CommonJS.
Peer dependencies: `@solana/kit` ^8.3, `@solana-program/token` ^0.16, `@solana-program/compute-budget` ^0.18,
and `@solana/subscriptions` ^0.5 for the `/subscriptions` entry only.

## Use with AI assistants

- GitMCP (an MCP server for this repo): `https://gitmcp.io/fianto-xyz/solana-payments`
- DeepWiki: `https://deepwiki.com/fianto-xyz/solana-payments`
- [`llms.txt`](llms.txt) at the repo root lists the README, the examples and the main source files.

## Security

Found a vulnerability? Please report it privately. See [SECURITY.md](SECURITY.md). Do not open a public issue.

## Hosted alternative

Don't want to run checkout yourself? [fianto](https://fianto.xyz) hosts checkout and subscriptions on Solana. See [`@fianto/sdk`](https://www.npmjs.com/package/@fianto/sdk).

## Contributing

Issues and pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
