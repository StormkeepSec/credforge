// The parts of the Open Badges 3.0 data model (spec appendix B.1) that credforge produces.
// Property names follow the spec exactly so documents can be built and read without mapping.

/** An absolute URL. */
export type Url = string;
/** An ISO 8601 date-time in UTC without fractional seconds, e.g. `2026-11-02T15:04:05Z`. */
export type DateTimeString = string;

export interface Image {
  id: Url;
  type: 'Image';
  caption?: string;
}

/** The issuer as embedded in a credential (spec B.1.14 `Profile`, minus the key material). */
export interface Profile {
  id: Url;
  type: string[];
  name: string;
  url?: Url;
  email?: string;
  phone?: string;
  description?: string;
  image?: Image;
}

export interface Criteria {
  id?: Url;
  narrative?: string;
}

export interface Alignment {
  type: string[];
  targetName: string;
  targetUrl: Url;
  targetDescription?: string;
  targetCode?: string;
  targetFramework?: string;
  targetType?: string;
}

export interface Achievement {
  id: Url;
  type: string[];
  achievementType?: string;
  name: string;
  description: string;
  criteria: Criteria;
  image?: Image;
  humanCode?: string;
  fieldOfStudy?: string;
  specialization?: string;
  version?: string;
  inLanguage?: string;
  creditsAvailable?: number;
  tag?: string[];
  alignment?: Alignment[];
}

/** spec B.1.12. `identityHash` is `sha256$<hex>` when hashed, otherwise the plain value. */
export interface IdentityObject {
  type: 'IdentityObject';
  identityType: string;
  hashed: boolean;
  identityHash: string;
  salt?: string;
}

export interface Result {
  type: string[];
  resultDescription?: Url;
  achievedLevel?: Url;
  status?: string;
  value?: string;
  alignment?: Alignment[];
}

export interface AchievementSubject {
  id?: string;
  type: string[];
  identifier?: IdentityObject[];
  achievement: Achievement;
  result?: Result[];
}

export interface Evidence {
  id?: Url;
  type: string[];
  name?: string;
  narrative?: string;
  description?: string;
  genre?: string;
  audience?: string;
}

export type StatusPurpose = 'revocation' | 'suspension';

/** W3C Bitstring Status List v1.0 §2.1. `statusListIndex` is a base-10 integer as a string. */
export interface BitstringStatusListEntry {
  id: Url;
  type: 'BitstringStatusListEntry';
  statusPurpose: StatusPurpose;
  statusListIndex: string;
  statusListCredential: Url;
}

export interface CredentialSchema {
  id: Url;
  type: string;
}

export interface DataIntegrityProof {
  type: 'DataIntegrityProof';
  cryptosuite: string;
  created: DateTimeString;
  verificationMethod: Url;
  proofPurpose: 'assertionMethod';
  proofValue: string;
}

export interface OpenBadgeCredential {
  '@context': string[];
  id: Url;
  type: string[];
  name: string;
  description?: string;
  image?: Image;
  issuer: Profile;
  validFrom: DateTimeString;
  validUntil?: DateTimeString;
  credentialSubject: AchievementSubject;
  evidence?: Evidence[];
  credentialStatus?: BitstringStatusListEntry;
  credentialSchema: CredentialSchema[];
}

export interface SignedOpenBadgeCredential extends OpenBadgeCredential {
  proof: DataIntegrityProof;
}

/** A Multikey verification method (W3C Controlled Identifiers v1.0 §2.2.2). */
export interface MultikeyVerificationMethod {
  id: Url;
  type: 'Multikey';
  controller: Url;
  publicKeyMultibase: string;
  revoked?: DateTimeString;
}

/**
 * The document served at the issuer's `id` URL: an OB `Profile` that is also a controller
 * document, so verifiers can find the issuer's keys.
 */
export interface IssuerProfileDocument extends Profile {
  '@context': string[];
  verificationMethod: MultikeyVerificationMethod[];
  assertionMethod: Url[];
}

export interface BitstringStatusList {
  id: Url;
  type: 'BitstringStatusList';
  statusPurpose: StatusPurpose;
  encodedList: string;
  ttl?: number;
}

export interface BitstringStatusListCredential {
  '@context': string[];
  id: Url;
  type: string[];
  issuer: Url;
  validFrom: DateTimeString;
  validUntil?: DateTimeString;
  credentialSubject: BitstringStatusList;
}

export interface SignedBitstringStatusListCredential extends BitstringStatusListCredential {
  proof: DataIntegrityProof;
}
