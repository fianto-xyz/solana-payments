/**
 * Something that can add ONE Ed25519 signature to a transaction.
 *
 * Deliberately the narrowest possible interface: base64 in, base64 out, an address to log.
 * It never exposes key material, a WebCrypto handle or a kit signer object, so no caller can
 * accidentally log a secret, and a KMS-backed implementation drops in without changing a call
 * site. `sign` ADDS this key's signature to whatever signatures the transaction already
 * carries; it never replaces the payer's.
 */
export interface TransactionSigner {
  /** The base58 public key. Safe to log; the secret behind it is not. */
  readonly address: string;
  /** @param base64 a wire transaction. @returns the same transaction, one signature richer. */
  sign(base64: string): Promise<string>;
}
