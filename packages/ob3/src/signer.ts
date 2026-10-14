/// <reference path="./digitalbazaar.d.ts" />
import * as Ed25519Multikey from '@digitalbazaar/ed25519-multikey';
import { verificationMethodId } from './keys';

/**
 * Signs proof data for a credential or status list. The in-process signer below holds the key in
 * memory; a KMS or HSM signer only has to implement this interface.
 */
export interface Signer {
  /** Goes into `proof.verificationMethod`: `{issuerId}#{publicKeyMultibase}`. */
  readonly verificationMethod: string;
  /** `Ed25519`, the algorithm eddsa-rdfc-2022 requires. */
  readonly algorithm: 'Ed25519';
  /** Returns the 64-byte Ed25519 signature over `data`. */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export interface Ed25519SignerOptions {
  /** The issuer id, which controls the key. */
  controller: string;
  publicKeyMultibase: string;
  secretKeyMultibase: string;
}

/**
 * Creates an in-process signer from a decrypted Multikey key pair. It signs and verifies a probe
 * message first, so a secret key that doesn't belong to the public key fails here rather than
 * producing credentials that never verify.
 */
export async function createEd25519Signer(options: Ed25519SignerOptions): Promise<Signer> {
  const verificationMethod = verificationMethodId(options.controller, options.publicKeyMultibase);
  const keyPair = await Ed25519Multikey.from({
    type: 'Multikey',
    id: verificationMethod,
    controller: options.controller,
    publicKeyMultibase: options.publicKeyMultibase,
    secretKeyMultibase: options.secretKeyMultibase,
  });
  const signer = keyPair.signer();

  const probe = new TextEncoder().encode(`credforge key check ${verificationMethod}`);
  const signature = await signer.sign({ data: probe });
  if (!(await keyPair.verifier().verify({ data: probe, signature }))) {
    throw new Error('The secret key does not match the public key.');
  }

  return {
    verificationMethod,
    algorithm: 'Ed25519',
    sign: (data) => signer.sign({ data }),
  };
}
