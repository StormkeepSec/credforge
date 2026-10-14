/// <reference path="./digitalbazaar.d.ts" />
import * as Ed25519Multikey from '@digitalbazaar/ed25519-multikey';

/**
 * An Ed25519 key pair in Multikey form. `publicKeyMultibase` starts with `z6Mk`;
 * `secretKeyMultibase` encodes the 32-byte seed (multicodec `ed25519-priv`) and must stay secret.
 */
export interface Ed25519KeyPair {
  publicKeyMultibase: string;
  secretKeyMultibase: string;
}

/** Generates a new Ed25519 signing key pair. Pass `seed` only in tests. */
export async function generateEd25519KeyPair(seed?: Uint8Array): Promise<Ed25519KeyPair> {
  const keyPair = await Ed25519Multikey.generate(seed ? { seed } : {});
  // `canonicalize` exports the 32-byte seed (`z3u2…`, as in the W3C test vectors) instead of the
  // library's legacy 64-byte seed-plus-public-key form.
  const exported = await keyPair.export({
    publicKey: true,
    secretKey: true,
    includeContext: false,
    canonicalize: true,
  });
  if (!exported.secretKeyMultibase) throw new Error('Key generation returned no secret key.');
  return {
    publicKeyMultibase: exported.publicKeyMultibase,
    secretKeyMultibase: exported.secretKeyMultibase,
  };
}

/**
 * The verification method id for a key: `{controller}#{publicKeyMultibase}`, the pattern the OB 3.0
 * examples use. The 1EdTech validator reads the key straight from this fragment.
 */
export function verificationMethodId(controller: string, publicKeyMultibase: string): string {
  return `${controller}#${publicKeyMultibase}`;
}

/**
 * Whether the value looks like a multibase Ed25519 public key: `z` (base58btc) followed by the
 * encoding of the `ed25519-pub` header and 32 key bytes, which is always `6Mk` plus 44 characters.
 */
export function isEd25519PublicKeyMultibase(value: string): boolean {
  return /^z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/.test(value);
}

/** Throws unless the value decodes to an Ed25519 public key (`z6Mk…`). */
export async function assertEd25519PublicKey(publicKeyMultibase: string): Promise<void> {
  if (!isEd25519PublicKeyMultibase(publicKeyMultibase)) {
    throw new TypeError('"publicKeyMultibase" must be an Ed25519 Multikey starting with "z6Mk".');
  }
  // Decodes the key and checks the multicodec header and length.
  await Ed25519Multikey.from({ type: 'Multikey', publicKeyMultibase });
}
