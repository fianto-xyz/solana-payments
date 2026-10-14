/**
 * Constant-shape byte-for-byte comparison, shared by every validator that must prove two
 * `Uint8Array`s are IDENTICAL rather than merely "decode to the same fields" — the compiled
 * transaction message re-encode/compare that closes the trailing-bytes gap, and the "the
 * message did not change" check after a co-signature. One shared loop, so no validator keeps
 * a private copy.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
