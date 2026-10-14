/** Lamports per SOL. */
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Lamports → the shortest decimal SOL string. Never exponent notation. */
export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
