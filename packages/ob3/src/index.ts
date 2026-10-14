// @credforge/ob3: the Open Badges 3.0 credential engine. Pure library: no database, no HTTP.

export { BakeError, type BakeOptions, bakePng, extractFromPng } from './bake-png';
export { bakeSvg, extractFromSvg } from './bake-svg';
export * from './constants';
export { PINNED_CONTEXTS } from './contexts';
export {
  type AchievementInput,
  type AlignmentInput,
  buildCredential,
  type CredentialInput,
  type EvidenceInput,
  type RecipientInput,
  type ResultInput,
} from './credential';
export { toDateTimeString } from './dates';
export {
  createDocumentLoader,
  type DocumentLoader,
  type DocumentLoaderOptions,
  DocumentNotFoundError,
  findVerificationMethod,
  type RemoteDocument,
} from './document-loader';
export {
  type IssueOptions,
  issueCredential,
  issueStatusListCredential,
  SelfCheckError,
} from './issue';
export {
  buildIssuerProfile,
  buildIssuerRef,
  type ImageInput,
  type IssuerInput,
  type IssuerKey,
} from './issuer-profile';
export {
  assertEd25519PublicKey,
  type Ed25519KeyPair,
  generateEd25519KeyPair,
  isEd25519PublicKeyMultibase,
  verificationMethodId,
} from './keys';
export {
  type ProofCheckOptions,
  type ProofCheckResult,
  type SignOptions,
  signCredential,
  verifyProof,
} from './proof';
export {
  emailIdentifier,
  generateSalt,
  hashIdentity,
  type IdentityHashAlgorithm,
  type KnownIdentifier,
  nameIdentifier,
  normalizeEmail,
  verifyRecipient,
} from './recipient';
export {
  type SchemaValidationResult,
  validateCredentialSchema,
  validateProfileSchema,
} from './schema';
export { createEd25519Signer, type Ed25519SignerOptions, type Signer } from './signer';
export {
  allocateRandomIndex,
  Bitstring,
  buildStatusListCredential,
  buildStatusListEntry,
  checkStatusListEntry,
  type StatusCheckOptions,
  type StatusCheckResult,
  type StatusListCredentialInput,
  type StatusListEntryInput,
  StatusListFullError,
} from './status-list';
export type * from './types';
export {
  type Check,
  type CheckOutcome,
  type CredentialVerification,
  checkFormat,
  checkValidity,
  controllerIdOf,
  type VerifyCredentialOptions,
  verifyCredential,
} from './verify';
