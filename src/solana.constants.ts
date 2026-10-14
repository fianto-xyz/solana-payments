import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

// Re-exported rather than retyped: one source of truth.
export { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, COMPUTE_BUDGET_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS };

export const SOLANA_CLUSTERS = ['mainnet-beta', 'devnet', 'localnet'] as const;
export type SolanaCluster = (typeof SOLANA_CLUSTERS)[number];

/** Circle's USDC mint on each public cluster. localnet has none: a local validator's mint is created fresh on every run. */
export const USDC_MINTS: Readonly<Record<'mainnet-beta' | 'devnet', string>> = {
  'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

/** Each public cluster's genesis hash — what `getGenesisHash` answers there, and the one thing that tells a mainnet RPC URL from a devnet one. */
export const CLUSTER_GENESIS_HASHES: Readonly<Record<'mainnet-beta' | 'devnet', string>> = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
};

/** getMultipleAccounts takes at most this many accounts per call. */
export const MAX_ACCOUNTS_PER_CALL = 100;

/** getSignatureStatuses takes at most this many signatures per call. */
export const MAX_SIGNATURES_PER_STATUS_CALL = 256;

// Two transferChecked instructions on existing accounts cost well under 20k CU; 60k leaves
// room for a wallet that adds nothing and still lands.
export const COMPUTE_UNIT_LIMIT = 60_000;
/** The base network fee per signature (`transactionFeeLamports`). */
export const LAMPORTS_PER_SIGNATURE = 5_000n;
export const COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 1_000n;
