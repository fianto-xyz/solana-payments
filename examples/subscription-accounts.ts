// Derive the accounts of a Solana Subscriptions plan and subscription, and map a program error.
import { generateKeyPairSigner } from '@solana/kit';
import { USDC_MINTS } from '@fianto/solana-payments';
import {
  derivePlanAddress, deriveSubscriptionAuthorityAddress, deriveSubscriptionAddress, programErrorMessage,
} from '@fianto/solana-payments/subscriptions';

const owner = await generateKeyPairSigner();
const payer = await generateKeyPairSigner();
const plan = await derivePlanAddress(owner.address, 1n);
console.log('plan:', plan);
console.log('authority:', await deriveSubscriptionAuthorityAddress(payer.address, USDC_MINTS.devnet));
console.log('subscription:', await deriveSubscriptionAddress(plan.address, payer.address));
console.log('error 130:', programErrorMessage(130));
