# @fianto/solana-payments

**Build and verify Solana USDC payments and subscriptions: typed, tested, built on `@solana/kit`.**

[![npm](https://img.shields.io/npm/v/@fianto/solana-payments)](https://www.npmjs.com/package/@fianto/solana-payments)
[![CI](https://github.com/fianto-xyz/solana-payments/actions/workflows/ci.yml/badge.svg)](https://github.com/fianto-xyz/solana-payments/actions/workflows/ci.yml)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@fianto/solana-payments)](https://bundlephobia.com/package/@fianto/solana-payments)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![TypeScript](https://img.shields.io/badge/types-included-blue)

Accepting a payment on Solana is easy. Making sure the wallet signed **exactly** the transaction
you built is not. This library builds USDC payment and subscription transactions and validates
the signed bytes that come back, instruction by instruction and byte for byte.

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

Each check below is a real attack on "build a transaction, let the wallet sign it":

- **Swapped or extended transaction.** The wallet (or malware in it) returns different bytes: another amount, another destination, an extra instruction. `validateSignedPayment` re-decodes the message, refuses any program but Token and ComputeBudget, checks every transfer's mint, decimals, source, destination, authority and amount, and refuses trailing bytes the message encoder would not produce.
- **Fee-payer swap.** A transaction whose fee payer is not the payer makes someone else pay for it. Refused as `wrong_fee_payer`.
- **Forgeable Ed25519 keys.** Some Ed25519 verifiers, including some WebCrypto builds, accept signatures from small-order and non-canonical public keys that need no private key at all. `verifyWalletSignature` rejects those keys itself, whatever the runtime does.
- **Decoy writable accounts.** For transactions a second party co-signs (subscriptions), an extra writable account or a promoted signer role can cost the co-signer money. `validateSignedSubscribe` checks the exact account list and signer roles.
- **Ambiguous RPC failures.** "The provider did not answer" and "the transaction failed" look alike in kit. `isTransportFailure` and `describeRpcFailure` tell them apart in every `NODE_ENV`.

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

## Security

Found a vulnerability? Please report it privately. See [SECURITY.md](SECURITY.md). Do not open a public issue.

## Hosted alternative

Don't want to run checkout yourself? [fianto](https://fianto.xyz) hosts checkout and subscriptions on Solana. See [`@fianto/sdk`](https://www.npmjs.com/package/@fianto/sdk).

## Contributing

Issues and pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
