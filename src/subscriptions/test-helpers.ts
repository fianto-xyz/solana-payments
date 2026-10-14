import { getBase64Decoder } from '@solana/kit';
import { getPlanEncoder, PlanStatus } from '@solana/subscriptions';
import type { OnchainPlanAccount } from './accounts.js';
import {
  MAX_PLAN_DESTINATIONS,
  MAX_PLAN_PULLERS,
  SUBSCRIPTIONS_ZERO_ADDRESS,
} from './subscriptions-program.constants.js';

/** The plan account discriminator, as the program writes it into byte 0. */
const PLAN_DISCRIMINATOR = 1;

/**
 * The SDK's own encoder, so a test fixture is the same bytes a cluster would serve: real bytes
 * driven through the real decoder, rather than a second hand-rolled encoder that would be the
 * thing most likely to be wrong.
 */
export function encodePlanAccountForTests(plan: OnchainPlanAccount): string {
  const pad = (addresses: string[], width: number): string[] => [
    ...addresses,
    ...Array.from({ length: width - addresses.length }, () => SUBSCRIPTIONS_ZERO_ADDRESS),
  ];
  const bytes = getPlanEncoder().encode({
    discriminator: PLAN_DISCRIMINATOR,
    owner: plan.owner as never,
    bump: 255,
    status: plan.status === 'ACTIVE' ? PlanStatus.Active : PlanStatus.Sunset,
    data: {
      planId: plan.planId,
      mint: plan.mint as never,
      terms: {
        amount: plan.amount,
        periodHours: BigInt(plan.periodHours),
        createdAt: plan.createdAt,
      },
      endTs: plan.endTs,
      destinations: pad(plan.destinations, MAX_PLAN_DESTINATIONS) as never,
      pullers: pad(plan.pullers, MAX_PLAN_PULLERS) as never,
      metadataUri: '',
    },
  } as never);
  return getBase64Decoder().decode(bytes as Uint8Array);
}
