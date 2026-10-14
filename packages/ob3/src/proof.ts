/// <reference path="./digitalbazaar.d.ts" />
import { DataIntegrityProof } from '@digitalbazaar/data-integrity';
import { cryptosuite } from '@digitalbazaar/eddsa-rdfc-2022-cryptosuite';
import * as vc from '@digitalbazaar/vc';
import { toDateTimeString } from './dates';
import {
  asArray,
  createDocumentLoader,
  type DocumentLoader,
  type DocumentLoaderOptions,
  isRecord,
} from './document-loader';
import type { Signer } from './signer';
import type { DataIntegrityProof as Proof } from './types';

export interface SignOptions {
  /** The proof's `created` time. Defaults to now. */
  created?: Date | string;
  /** Defaults to the pinned loader, which is all a credforge credential needs for signing. */
  documentLoader?: DocumentLoader;
}

/**
 * Adds a `DataIntegrityProof` (eddsa-rdfc-2022, proof purpose `assertionMethod`) to a copy of the
 * credential. Canonicalization runs in JSON-LD safe mode, so an undefined term or relative IRI
 * anywhere in the credential makes signing fail instead of silently dropping data.
 */
export async function signCredential<T extends object>(
  credential: T,
  signer: Signer,
  options: SignOptions = {},
): Promise<T & { proof: Proof }> {
  if ('proof' in credential) throw new TypeError('The credential already has a proof.');
  const suite = new DataIntegrityProof({
    cryptosuite,
    date: new Date(toDateTimeString(options.created ?? new Date(), 'created')),
    signer: {
      id: signer.verificationMethod,
      algorithm: signer.algorithm,
      sign: ({ data }) => signer.sign(data),
    },
  });
  const signed = await vc.issue({
    credential: structuredClone(credential),
    suite,
    documentLoader: options.documentLoader ?? createDocumentLoader(),
  });
  return signed as T & { proof: Proof };
}

export interface ProofCheckOptions extends DocumentLoaderOptions {
  /**
   * The issuer's controller document (issuer profile). Its keys are the only keys the proof can
   * be checked against. Usually the result of dereferencing the issuer id.
   */
  controller: unknown;
}

export interface ProofCheckResult {
  verified: boolean;
  /** Why verification failed, in plain words. */
  errors: string[];
}

/**
 * Verifies the credential's eddsa-rdfc-2022 proof with Digital Bazaar's verifier: the signature,
 * that the key is listed in the controller document's `assertionMethod`, and that the key's
 * controller is the credential's issuer. Dates and status are not checked here.
 */
export async function verifyProof(
  credential: unknown,
  options: ProofCheckOptions,
): Promise<ProofCheckResult> {
  if (!isRecord(credential)) {
    return { verified: false, errors: ['The credential is not an object.'] };
  }
  const proofs = asArray(credential.proof);
  if (proofs.length === 0) return { verified: false, errors: ['The credential has no proof.'] };

  let documentLoader: DocumentLoader;
  try {
    documentLoader = createDocumentLoader({
      ...options,
      documents: [options.controller, ...(options.documents ?? [])],
    });
  } catch (error) {
    return { verified: false, errors: [`Issuer profile: ${messageOf(error)}`] };
  }

  const result = await vc.verifyCredential({
    credential,
    suite: new DataIntegrityProof({ cryptosuite }),
    documentLoader,
    // The validity period is reported as its own check, so the signature check uses a time
    // inside it: a credential that has expired still has a valid signature.
    now: typeof credential.validFrom === 'string' ? credential.validFrom : undefined,
    // Status is its own check too (`verifyCredential` runs it).
    checkStatus: async () => ({ verified: true }),
  });
  if (result.verified) return { verified: true, errors: [] };

  const errors = new Set<string>();
  if (result.error !== undefined) errors.add(messageOf(result.error));
  for (const entry of result.results ?? []) {
    if (entry.error !== undefined) errors.add(messageOf(entry.error));
  }
  if (errors.size === 0) errors.add('The proof did not verify.');
  return { verified: false, errors: [...errors] };
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // jsonld-signatures wraps per-proof failures in a VerificationError with an `errors` list.
    const nested = (error as Error & { errors?: unknown[] }).errors;
    if (Array.isArray(nested) && nested.length > 0) return nested.map(messageOf).join('; ');
    return error.message;
  }
  return String(error);
}
