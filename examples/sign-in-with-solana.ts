// Render a SIWS message, sign it with a wallet key, verify it, and read back the nonce.
import { generateKeyPairSigner, signBytes } from '@solana/kit';
import { renderSiwsMessage, siwsChainId, nonceOfSiwsMessage, verifyWalletSignature, SIWS_VERSION } from '@fianto/solana-payments';

const wallet = await generateKeyPairSigner();
const now = new Date();
const message = renderSiwsMessage({
  domain: 'app.example.com',
  address: wallet.address,
  statement: 'Sign in to Example.',
  uri: 'https://app.example.com',
  version: SIWS_VERSION,
  chainId: siwsChainId('devnet'),
  nonce: crypto.randomUUID().replaceAll('-', ''),
  issuedAt: now.toISOString(),
  expirationTime: new Date(now.getTime() + 5 * 60_000).toISOString(),
});
const signature = await signBytes(wallet.keyPair.privateKey, new TextEncoder().encode(message));

console.log(message, '\n');
console.log('signature valid:', await verifyWalletSignature(wallet.address, message, signature));
console.log('nonce:', nonceOfSiwsMessage(message));
