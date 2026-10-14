import * as root from './index.js';
import * as subscriptions from './subscriptions/index.js';
import * as money from './money/index.js';

const runtimeNames = (m: object) => Object.keys(m).sort();

describe('public API', () => {
  it('root exports exactly the payments surface', () => {
    expect(runtimeNames(root)).toEqual([
      'ASSOCIATED_TOKEN_PROGRAM_ADDRESS', 'AccountBatcher', 'CLUSTER_GENESIS_HASHES', 'COMPUTE_BUDGET_PROGRAM_ADDRESS',
      'COMPUTE_UNIT_LIMIT', 'COMPUTE_UNIT_PRICE_MICRO_LAMPORTS', 'LAMPORTS_PER_SIGNATURE', 'MAX_ACCOUNTS_PER_CALL',
      'MAX_SIGNATURES_PER_STATUS_CALL', 'MAX_SIGNED_TRANSACTION_BASE64', 'RpcProviderRefusedError', 'SIWS_VERSION',
      'SOLANA_CLUSTERS', 'SolanaProviderUnavailableError', 'SolanaRpcBusyError', 'TOKEN_PROGRAM_ADDRESS', 'USDC_MINTS',
      'associatedTokenSearchSteps', 'buildPaymentTransaction', 'deriveAssociatedTokenAddress', 'describeRpcFailure',
      'isPreflightInstructionFailure', 'isRpcUnavailable', 'isTransientTransactionError', 'isTransportFailure',
      'nonceOfSiwsMessage', 'providerCannotAnswer', 'renderSiwsMessage', 'siwsChainId', 'tokenAccountFrom',
      'transactionFeeLamports', 'validateSignedPayment', 'verifyCoSignedTransaction', 'verifyWalletSignature',
      'withProviderRefusals',
    ]);
  });

  it('subscriptions does not export the test helper', () => {
    expect(runtimeNames(subscriptions)).not.toContain('encodePlanAccountForTests');
    expect(runtimeNames(subscriptions)).toEqual(expect.arrayContaining([
      'buildSubscribeTransaction', 'validateSignedSubscribe', 'buildChargeTransaction', 'compileChargeTransaction',
      'signChargeTransaction', 'ChargeBuildRefused', 'buildCreatePlanTransaction', 'buildUpdatePlanPullersTransaction',
      'buildSunsetPlanTransaction', 'planMatches', 'buildPayerActionTransaction', 'validateSignedPayerAction',
      'derivePlanAddress', 'deriveSubscriptionAddress', 'deriveSubscriptionAuthorityAddress', 'deriveEventAuthorityAddress',
      'decodePlanAccount', 'decodeSubscriptionAccount', 'decodeAuthorityAccount', 'readPlanAccount',
      'readSubscriptionAccount', 'readAuthorityAccount', 'programErrorCodeOf', 'programErrorMessage',
      'SUBSCRIPTION_PROGRAM_ERRORS', 'SUBSCRIPTIONS_PROGRAM_ID', 'computeBudgetDataLength',
    ]));
  });

  it('money exports only pure helpers', () => {
    expect(runtimeNames(money)).toEqual([
      'BPS_DENOMINATOR', 'LAMPORTS_PER_SOL', 'U64_MAX', 'USDC_AMOUNT_PATTERN', 'USDC_DECIMALS', 'computeFee',
      'formatBpsPercent', 'formatSol', 'formatUsdcAmount', 'isAmountInRange', 'parseUsdcAmount',
    ]);
  });
});
