import { ISSUER_PROFILE_CONTEXT } from './constants';
import { toDateTimeString } from './dates';
import { isEd25519PublicKeyMultibase, verificationMethodId } from './keys';
import type {
  Image,
  IssuerProfileDocument,
  MultikeyVerificationMethod,
  Profile,
  Url,
} from './types';
import { assertAbsoluteUrl, compact, requireText } from './util';

export interface ImageInput {
  id: Url;
  caption?: string;
}

export interface IssuerInput {
  /** The issuer's permanent URL, `{PUBLIC_BASE_URL}/issuers/{uuid}` (or a `did:web` DID). */
  id: Url;
  name: string;
  /** The organization's own website. */
  url?: Url;
  email?: string;
  phone?: string;
  description?: string;
  image?: Url | ImageInput;
}

export interface IssuerKey {
  publicKeyMultibase: string;
  /**
   * Set for a revoked key. It stays listed in `verificationMethod` with this `revoked` date but is
   * removed from `assertionMethod`, so credentials it signed no longer verify. Active and retired
   * keys are both listed in `assertionMethod`.
   */
  revoked?: Date | string;
}

/** The issuer as embedded in each credential: the public profile fields, no keys. */
export function buildIssuerRef(issuer: IssuerInput): Profile {
  assertAbsoluteUrl(issuer.id, 'issuer.id');
  if (issuer.url !== undefined) assertAbsoluteUrl(issuer.url, 'issuer.url');
  return compact({
    id: issuer.id,
    type: ['Profile'],
    name: requireText(issuer.name, 'issuer.name'),
    url: issuer.url,
    email: issuer.email,
    phone: issuer.phone,
    description: issuer.description,
    image: toImage(issuer.image, 'issuer.image'),
  });
}

/**
 * Builds the JSON document served at the issuer's id URL. It is an OB `Profile` and also a W3C
 * controller document: each key is a `Multikey` verification method `{id}#{publicKeyMultibase}`
 * referenced from `assertionMethod`. The Controlled Identifiers context defines those terms; the
 * OB and VCDM contexts don't.
 *
 * Shape rules that keep both Digital Bazaar's verifier and the 1EdTech validator working:
 * `verificationMethod` is always an array, `assertionMethod` holds id strings (not embedded
 * objects), and every method's `controller` is exactly the issuer id.
 */
export function buildIssuerProfile(
  issuer: IssuerInput & { keys: IssuerKey[] },
): IssuerProfileDocument {
  const profile = buildIssuerRef(issuer);
  if (issuer.keys.length === 0) throw new TypeError('An issuer profile needs at least one key.');

  const verificationMethod: MultikeyVerificationMethod[] = [];
  const assertionMethod: Url[] = [];
  for (const key of issuer.keys) {
    if (!isEd25519PublicKeyMultibase(key.publicKeyMultibase)) {
      throw new TypeError(`"${key.publicKeyMultibase}" is not an Ed25519 Multikey (z6Mk…).`);
    }
    const id = verificationMethodId(issuer.id, key.publicKeyMultibase);
    if (verificationMethod.some((method) => method.id === id)) {
      throw new TypeError(`Key ${key.publicKeyMultibase} is listed twice.`);
    }
    verificationMethod.push(
      compact({
        id,
        type: 'Multikey' as const,
        controller: issuer.id,
        publicKeyMultibase: key.publicKeyMultibase,
        revoked: key.revoked === undefined ? undefined : toDateTimeString(key.revoked, 'revoked'),
      }),
    );
    if (key.revoked === undefined) assertionMethod.push(id);
  }

  return {
    '@context': [...ISSUER_PROFILE_CONTEXT],
    ...profile,
    verificationMethod,
    assertionMethod,
  };
}

export function toImage(image: Url | ImageInput | undefined, name: string): Image | undefined {
  if (image === undefined) return undefined;
  const { id, caption } = typeof image === 'string' ? { id: image, caption: undefined } : image;
  assertAbsoluteUrl(id, `${name}.id`);
  return compact({ id, type: 'Image' as const, caption });
}
