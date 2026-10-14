import { generateKeyPair, getAddressDecoder, getAddressFromPublicKey, signBytes } from '@solana/kit';
import { verifyWalletSignature } from './wallet-signature.js';

const MESSAGE = new TextEncoder().encode('sign in to example');

async function wallet() {
  const keyPair = await generateKeyPair();
  return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
}

// The ed25519 group order L = 2^252 + 27742317777372353535851937790883648493.
const ED25519_GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;

function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

function bigIntToBytesLE(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let value = n;
  for (let i = 0; i < length; i++) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

describe('verifyWalletSignature', () => {
  it('accepts the wallet’s own ed25519 signature over the exact bytes', async () => {
    const signer = await wallet();
    const signature = await signBytes(signer.keyPair.privateKey, MESSAGE);
    expect(await verifyWalletSignature(signer.address, MESSAGE, signature)).toBe(true);
  });

  it('accepts a message given as a string, encoded the same way it renders', async () => {
    const signer = await wallet();
    const text = 'sign in to example';
    const signature = await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(text));
    expect(await verifyWalletSignature(signer.address, text, signature)).toBe(true);
  });

  it('refuses the same signature over different bytes', async () => {
    const signer = await wallet();
    const signature = await signBytes(signer.keyPair.privateKey, MESSAGE);
    const other = new TextEncoder().encode('sign in to example!');
    expect(await verifyWalletSignature(signer.address, other, signature)).toBe(false);
  });

  it('refuses a signature made by a different wallet', async () => {
    const signer = await wallet();
    const impostor = await wallet();
    const signature = await signBytes(impostor.keyPair.privateKey, MESSAGE);
    expect(await verifyWalletSignature(signer.address, MESSAGE, signature)).toBe(false);
  });

  it('refuses a signature that is not 64 bytes, without throwing', async () => {
    const signer = await wallet();
    const signature = await signBytes(signer.keyPair.privateKey, MESSAGE);
    expect(await verifyWalletSignature(signer.address, MESSAGE, signature.slice(0, 63))).toBe(false);
  });

  it('refuses a wallet that is not a base58 32-byte key, without throwing', async () => {
    const signer = await wallet();
    const signature = await signBytes(signer.keyPair.privateKey, MESSAGE);
    expect(await verifyWalletSignature('not-a-wallet', MESSAGE, signature)).toBe(false);
  });

  it('never imports the key when the signature length is wrong (pins the length guard against a WebCrypto that might not itself reject it)', async () => {
    const signer = await wallet();
    const signature = await signBytes(signer.keyPair.privateKey, MESSAGE);
    const importKeySpy = vi.spyOn(crypto.subtle, 'importKey');
    try {
      expect(await verifyWalletSignature(signer.address, MESSAGE, signature.slice(0, 63))).toBe(false);
      expect(importKeySpy).not.toHaveBeenCalled();
    } finally {
      importKeySpy.mockRestore();
    }
  });

  it('refuses a signature malleated by adding the group order L to S', async () => {
    const signer = await wallet();
    const signature = await signBytes(signer.keyPair.privateKey, MESSAGE);
    const s = bytesToBigIntLE(signature.slice(32, 64));
    const malleatedS = bigIntToBytesLE(s + ED25519_GROUP_ORDER, 32);
    const malleated = new Uint8Array(64);
    malleated.set(signature.slice(0, 32), 0);
    malleated.set(malleatedS, 32);
    expect(await verifyWalletSignature(signer.address, MESSAGE, malleated)).toBe(false);
  });

  it('never throws for null, undefined or numeric wallet, message or signature', async () => {
    const signer = await wallet();
    const signature = await signBytes(signer.keyPair.privateKey, MESSAGE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = [null, undefined, 42] as any[];
    for (const value of bad) {
      expect(await verifyWalletSignature(value, MESSAGE, signature)).toBe(false);
      expect(await verifyWalletSignature(signer.address, value, signature)).toBe(false);
      expect(await verifyWalletSignature(signer.address, MESSAGE, value)).toBe(false);
    }
  });

  it('refuses a message that is neither a string nor a Uint8Array, without silently treating it as empty bytes', async () => {
    const signer = await wallet();
    const signature = await signBytes(signer.keyPair.privateKey, MESSAGE);
    const verifySpy = vi.spyOn(crypto.subtle, 'verify');
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bad = [42, [], {}, null, undefined] as any[];
      for (const value of bad) {
        expect(await verifyWalletSignature(signer.address, value, signature)).toBe(false);
      }
      // None of these should ever have reached crypto.subtle.verify (which would have treated a
      // number or array as the empty message rather than refusing it up front).
      expect(verifySpy).not.toHaveBeenCalled();
    } finally {
      verifySpy.mockRestore();
    }
  });

  describe('forgeable public keys', () => {
    const dec = getAddressDecoder();

    // Each forgery below is R (32 bytes) || S = 0 (32 zero bytes), for a public key of order
    // dividing 8. Because such a key's order divides 8, the verification equation
    // [S]B == R + [h]A holds for S = 0 whenever R happens to equal -[h]A for the message's own
    // hash h = SHA512(R||A||M) mod L — a self-consistent condition with no private key involved
    // anywhere. Found by search: for each key below, trying R among the same handful of
    // low-order encodings against a short, fixed sequence of candidate messages found a hit
    // within 15 tries. Every fixture is checked TWICE: first that raw `crypto.subtle.verify`
    // ACCEPTS it (proving it is a genuine forgery, not an arbitrary rejection case), then that
    // `verifyWalletSignature` refuses it.
    const CASES: { label: string; publicKey: number[]; r: number[]; message: string }[] = [
      {
        label: 'identity (order 1)',
        publicKey: [1, ...Array.from<number>({ length: 31 }).fill(0)],
        r: [1, ...Array.from<number>({ length: 31 }).fill(0)],
        message: 'forgery search message #0',
      },
      {
        label: 'all-zero key (order 4)',
        publicKey: Array.from<number>({ length: 32 }).fill(0),
        r: [0xec, ...Array.from<number>({ length: 30 }).fill(0xff), 0x7f],
        message: 'forgery search message #0',
      },
      {
        label: 'all-zero key, sign bit flipped (order 4, non-canonical sign)',
        publicKey: [...Array.from<number>({ length: 31 }).fill(0), 0x80],
        r: [...Array.from<number>({ length: 31 }).fill(0), 0x80],
        message: 'forgery search message #0',
      },
      {
        label: 'y = p (non-canonical encoding of 0, order 4)',
        publicKey: [0xed, ...Array.from<number>({ length: 30 }).fill(0xff), 0x7f],
        r: [...Array.from<number>({ length: 31 }).fill(0), 0x80],
        message: 'forgery search message #12',
      },
      {
        label: 'y = p + 1 (non-canonical encoding of 1, order 1)',
        publicKey: [0xee, ...Array.from<number>({ length: 30 }).fill(0xff), 0x7f],
        r: [1, ...Array.from<number>({ length: 31 }).fill(0)],
        message: 'forgery search message #0',
      },
      {
        label: 'p - 1 (order 2)',
        publicKey: [0xec, ...Array.from<number>({ length: 30 }).fill(0xff), 0x7f],
        r: [1, ...Array.from<number>({ length: 31 }).fill(0)],
        message: 'forgery search message #2',
      },
      {
        label: 'order-8 point A',
        publicKey: [
          0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4, 0x89, 0xf2, 0xef, 0x98, 0xf0, 0xd5, 0xdf,
          0xac, 0x05, 0xd3, 0xc6, 0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x05,
        ],
        r: [
          0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67, 0x0f, 0x2a, 0x20,
          0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a,
        ],
        message: 'forgery search message #14',
      },
      {
        label: 'order-8 point B',
        publicKey: [
          0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67, 0x0f, 0x2a, 0x20,
          0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a,
        ],
        r: [
          0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67, 0x0f, 0x2a, 0x20,
          0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a,
        ],
        message: 'forgery search message #5',
      },
    ];

    it.each(CASES)('refuses the $label forgery', async ({ publicKey, r, message }) => {
      const publicKeyBytes = Uint8Array.from(publicKey);
      const messageBytes = new TextEncoder().encode(message);
      const forgedSignature = new Uint8Array(64);
      forgedSignature.set(Uint8Array.from(r), 0);
      // S is left as 32 zero bytes.

      // Prove the fixture is a genuine forgery against raw WebCrypto first.
      const key = await crypto.subtle.importKey('raw', publicKeyBytes, 'Ed25519', false, ['verify']);
      expect(await crypto.subtle.verify('Ed25519', key, forgedSignature, messageBytes)).toBe(true);

      const address = dec.decode(publicKeyBytes);
      expect(await verifyWalletSignature(address, messageBytes, forgedSignature)).toBe(false);
    });

    it('never imports the key for a non-canonical y >= p key that is NOT on the small-order blocklist', async () => {
      // y = p + 5, little-endian bytes [0xf1, 0xff * 30, 0x7f]. Not one of the 7 blacklisted
      // points (no forgery exists for it — it is either off-curve or of large order), so the
      // canonical-range check (y >= p) is the ONLY thing that can reject it; pin that with an
      // importKey spy exactly like the length guard above.
      const yPlus5 = Uint8Array.from([0xf1, ...Array.from<number>({ length: 30 }).fill(0xff), 0x7f]);
      const address = dec.decode(yPlus5);
      const signature = new Uint8Array(64); // shape doesn't matter; the key check runs first
      const importKeySpy = vi.spyOn(crypto.subtle, 'importKey');
      try {
        expect(await verifyWalletSignature(address, MESSAGE, signature)).toBe(false);
        expect(importKeySpy).not.toHaveBeenCalled();
      } finally {
        importKeySpy.mockRestore();
      }
    });
  });
});
