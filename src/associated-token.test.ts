import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { associatedTokenSearchSteps, deriveAssociatedTokenAddress } from './associated-token.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from './solana.constants.js';

const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

describe('deriveAssociatedTokenAddress', () => {
  // Fixed vectors: these owners are the public keys of the all-1s, all-2s, all-3s and all-4s
  // 32-byte private keys, so anyone can regenerate them.
  it.each([
    ['AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9', MAINNET_USDC, '3wvJdyFnGvaMWpbq93NU91SggiVRveULUXL6iX5VZDGP'],
    ['9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu', MAINNET_USDC, 'ASZ2TDDNJG2n42TxAezqNNzwWipykHrENDKMCoLKgzup'],
    ['GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse', DEVNET_USDC, '6ndWAgFxMAVLobD8WrdBj5w41GrDeJYiQX91nNSrwkZp'],
  ])('derives the ATA of %s', async (owner, mint, expected) => {
    expect(await deriveAssociatedTokenAddress(owner, mint)).toBe(expected);
  });

  it('agrees with deriving the PDA by hand from the documented seeds', async () => {
    const owner = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
    const encoder = getAddressEncoder();
    const [byHand] = await getProgramDerivedAddress({
      programAddress: address(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      seeds: [
        encoder.encode(address(owner)),
        encoder.encode(address(TOKEN_PROGRAM_ADDRESS)),
        encoder.encode(address(MAINNET_USDC)),
      ],
    });
    expect(await deriveAssociatedTokenAddress(owner, MAINNET_USDC)).toBe(byHand);
  });

  it('rejects an address that is not base58 of 32 bytes', async () => {
    await expect(deriveAssociatedTokenAddress('not-an-address', MAINNET_USDC)).rejects.toThrow();
  });
});

describe('associatedTokenSearchSteps', () => {
  it('is 255 minus the bump the token account address was found with', async () => {
    for (const owner of ['GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse', 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1']) {
      const steps = await associatedTokenSearchSteps(owner, MAINNET_USDC);
      const [ata, bump] = await getProgramDerivedAddress({
        programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
        seeds: [
          getAddressEncoder().encode(address(owner)),
          getAddressEncoder().encode(TOKEN_PROGRAM_ADDRESS),
          getAddressEncoder().encode(address(MAINNET_USDC)),
        ],
      });
      expect(steps).toBe(255 - bump);
      expect(await deriveAssociatedTokenAddress(owner, MAINNET_USDC)).toBe(ata);
    }
    expect(await associatedTokenSearchSteps('EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1', MAINNET_USDC)).toBe(1);
  });
});
