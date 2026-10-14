// Build a USDC payment, sign it as the payer would, then validate it — and catch a tampered copy.
import { generateKeyPairSigner, partiallySignTransaction, getTransactionDecoder, getBase64Encoder, getBase64EncodedWireTransaction } from '@solana/kit';
import {
  buildPaymentTransaction, validateSignedPayment, deriveAssociatedTokenAddress,
  USDC_MINTS, COMPUTE_UNIT_LIMIT, COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
} from '@fianto/solana-payments';
import { parseUsdcAmount, computeFee } from '@fianto/solana-payments/money';

const mint = USDC_MINTS.devnet;
const payer = await generateKeyPairSigner();
const recipient = await generateKeyPairSigner();
const feeRecipient = await generateKeyPairSigner();
const reference = (await generateKeyPairSigner()).address;
const { feeAmount } = computeFee(parseUsdcAmount('25.00')!, 100); // 1%

const input = {
  payerWallet: payer.address,
  payerTokenAccount: await deriveAssociatedTokenAddress(payer.address, mint),
  recipientTokenAccount: await deriveAssociatedTokenAddress(recipient.address, mint),
  feeRecipientTokenAccount: await deriveAssociatedTokenAddress(feeRecipient.address, mint),
  mint,
  decimals: 6,
  amount: parseUsdcAmount('25.00')!,
  feeAmount,
  reference,
  blockhash: '11111111111111111111111111111111', // use getLatestBlockhash() in a real app
  lastValidBlockHeight: 1_000n,
  computeUnitLimit: COMPUTE_UNIT_LIMIT,
  computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
};

const built = await buildPaymentTransaction(input);
// In a real app the wallet signs `built.base64`; here the payer key does it.
const tx = getTransactionDecoder().decode(getBase64Encoder().encode(built.base64));
const signed = getBase64EncodedWireTransaction(await partiallySignTransaction([payer.keyPair], tx));

const { computeUnitLimit: _limit, computeUnitPriceMicroLamports: _price, lastValidBlockHeight: _height, ...expectation } = input; // build-only settings are not part of the expectation
console.log('valid:', await validateSignedPayment(signed, expectation));
console.log('tampered:', await validateSignedPayment(signed, { ...expectation, amount: expectation.amount + 1n }));
