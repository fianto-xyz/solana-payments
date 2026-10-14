import { address, getAddressEncoder } from '@solana/kit';

const ED25519_SIGNATURE_BYTES = 64;

/**
 * p = 2^255 - 19, the ed25519 field prime. A canonical y-coordinate is strictly less than
 * this. y >= p (e.g. y = p itself) is a NON-canonical encoding: some verifiers reduce it mod p
 * before use, so a key encoded this way and the key encoding the reduced value would be treated
 * as the same point under one verifier and as different addresses under another.
 */
const ED25519_FIELD_PRIME = (1n << 255n) - 19n;

/**
 * The 7 small-order point encodings libsodium's `ge25519_has_small_order` rejects, copied
 * byte-for-byte from `crypto_core/ed25519/ref10/ed25519_ref10.c` (the `blacklist` table),
 * libsodium 1.0.18:
 * https://github.com/jedisct1/libsodium/blob/1.0.18/src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c#L1019-L1056
 *
 * Each entry here stores the sign-bit-CLEAR form. libsodium's own comparison masks the input's
 * sign bit (the top bit of byte 31) off before matching every entry, so both sign-bit encodings
 * of each of these 7 points are rejected; `isSmallOrderKey` below does the same masking.
 *
 * Why this matters: a public key of order dividing 8 lets an attacker forge a signature with NO
 * private key. Node's WebCrypto Ed25519 verify (OpenSSL) is cofactorless and does not reject
 * these on its own — reproduced directly against `crypto.subtle` on Node 24.10 for several of
 * these exact encodings, including R = the identity point with S = 0, which verifies for EVERY
 * message once the identity point is accepted as a public key (see wallet-signature.test.ts).
 */
const SMALL_ORDER_Y_BLACKLIST: readonly Uint8Array[] = [
  // 0 (order 4)
  Uint8Array.from([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]),
  // 1 (order 1) — the group identity
  Uint8Array.from([
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]),
  // 2707385501144840649318225287225658788936804267575313519463743609750303402022 (order 8)
  Uint8Array.from([
    0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4, 0x89, 0xf2, 0xef, 0x98, 0xf0,
    0xd5, 0xdf, 0xac, 0x05, 0xd3, 0xc6, 0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x05,
  ]),
  // 55188659117513257062467267217118295137698188065244968500265048394206261417927 (order 8)
  Uint8Array.from([
    0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67, 0x0f,
    0x2a, 0x20, 0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a,
  ]),
  // p-1 (order 2)
  Uint8Array.from([
    0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
  ]),
  // p (=0, order 4, non-canonical)
  Uint8Array.from([
    0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
  ]),
  // p+1 (=1, order 1, non-canonical)
  Uint8Array.from([
    0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
  ]),
];

/**
 * The 255-bit y-coordinate a 32-byte ed25519 encoding carries: little-endian, with the sign bit
 * (the top bit of byte 31) excluded.
 */
function yCoordinateOf(encoded: Uint8Array): bigint {
  let y = 0n;
  for (let i = 31; i >= 0; i--) {
    const byte = i === 31 ? encoded[i] & 0x7f : encoded[i];
    y = (y << 8n) | BigInt(byte);
  }
  return y;
}

/** True for any of the 7 small-order points above, in either sign-bit encoding. */
function isSmallOrderKey(encoded: Uint8Array): boolean {
  return SMALL_ORDER_Y_BLACKLIST.some((entry) => {
    for (let i = 0; i < 31; i++) {
      if (entry[i] !== encoded[i]) return false;
    }
    return entry[31] === (encoded[31] & 0x7f);
  });
}

/**
 * True when `encoded` is a public key a cofactorless verifier (Node's WebCrypto Ed25519 among
 * them) will accept a forged signature for, with no private key at all: a non-canonical y
 * (y >= p) or one of the 7 points of order dividing 8.
 */
function isForgeableEd25519PublicKey(encoded: Uint8Array): boolean {
  return yCoordinateOf(encoded) >= ED25519_FIELD_PRIME || isSmallOrderKey(encoded);
}

/**
 * True exactly when `signature` is `wallet`'s ed25519 signature over `message`. A Solana wallet
 * address IS the raw 32-byte ed25519 public key, base58-encoded, so the key is imported
 * straight from it — no lookup, no RPC.
 *
 * `message` must be a `string` (UTF-8 encoded here) or a `Uint8Array` — nothing else. This is
 * checked explicitly, not left to `Uint8Array.from`: `Uint8Array.from(42)` silently produces an
 * EMPTY array (a number has no `.length`), so a numeric or otherwise malformed message would
 * otherwise be verified as if it were empty instead of being refused.
 *
 * Never throws: every read of `wallet`, `message` and `signature` happens inside the `try`
 * below, so a malformed wallet, a signature that isn't array-like (including `null`, `undefined`
 * or a number), a message of the wrong type, a signature of the wrong length, a forgeable public
 * key, or a WebCrypto refusal is all `false`. Every input here is caller-controlled (a SIWS
 * request body, a signed transaction), and a verdict, not an exception, is what every
 * caller branches on.
 *
 * Rejects a forgeable public key (see `isForgeableEd25519PublicKey`) before ever calling
 * `importKey`: Node's WebCrypto Ed25519 verify is cofactorless and does not itself reject
 * small-order or non-canonical keys, so without this check a signature could be forged for one
 * with no private key — this function decides who signed.
 *
 * `Uint8Array.from` copies `signature` into a plain ArrayBuffer-backed array, which is what
 * WebCrypto's `BufferSource` requires under TypeScript 6's typed-array generics.
 */
export async function verifyWalletSignature(
  wallet: string,
  message: string | Uint8Array,
  signature: ArrayLike<number>,
): Promise<boolean> {
  try {
    if (signature.length !== ED25519_SIGNATURE_BYTES) return false;
    if (typeof message !== 'string' && !(message instanceof Uint8Array)) return false;
    const messageBytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
    const publicKey = Uint8Array.from(getAddressEncoder().encode(address(wallet)));
    if (isForgeableEd25519PublicKey(publicKey)) return false;
    const key = await crypto.subtle.importKey('raw', publicKey, 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, Uint8Array.from(signature), messageBytes);
  } catch {
    return false;
  }
}
