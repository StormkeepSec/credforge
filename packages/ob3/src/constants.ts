/** W3C Verifiable Credentials Data Model 2.0 context. Always first in `@context`. */
export const VC_CONTEXT_V2 = 'https://www.w3.org/ns/credentials/v2';
/** Open Badges 3.0 context, version 3.0.3 (the version the spec examples and the validator use). */
export const OB_CONTEXT_V3 = 'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json';
/**
 * Open Badges 3.0 extensions context. It defines `1EdTechJsonSchemaValidator2019`, the
 * `credentialSchema` type. Without it that type is an undefined term and JSON-LD canonicalization
 * in safe mode (which eddsa-rdfc-2022 requires) rejects the credential.
 */
export const OB_EXTENSIONS_CONTEXT = 'https://purl.imsglobal.org/spec/ob/v3p0/extensions.json';
/** W3C Controlled Identifiers v1.0: `verificationMethod`, `assertionMethod`, `Multikey`. */
export const CID_CONTEXT_V1 = 'https://www.w3.org/ns/cid/v1';
/** Multikey context. Digital Bazaar's key library requires it on a dereferenced key. */
export const MULTIKEY_CONTEXT_V1 = 'https://w3id.org/security/multikey/v1';
/** Data Integrity v2 context, for documents that don't use the VCDM 2.0 context. */
export const DATA_INTEGRITY_CONTEXT_V2 = 'https://w3id.org/security/data-integrity/v2';

/** `@context` of every OpenBadgeCredential credforge issues. */
export const CREDENTIAL_CONTEXT = [VC_CONTEXT_V2, OB_CONTEXT_V3, OB_EXTENSIONS_CONTEXT];
/** `@context` of the issuer profile, which is also the issuer's controller document. */
export const ISSUER_PROFILE_CONTEXT = [VC_CONTEXT_V2, OB_CONTEXT_V3, CID_CONTEXT_V1];
/** `@context` of a BitstringStatusListCredential (its terms are in the VCDM 2.0 context). */
export const STATUS_LIST_CREDENTIAL_CONTEXT = [VC_CONTEXT_V2];

/** The official JSON Schema for OB 3.0 AchievementCredential / OpenBadgeCredential. */
export const ACHIEVEMENT_CREDENTIAL_SCHEMA_URL =
  'https://purl.imsglobal.org/spec/ob/v3p0/schema/json/ob_v3p0_achievementcredential_schema.json';
/** The official JSON Schema for OB 3.0 Profile. */
export const PROFILE_SCHEMA_URL =
  'https://purl.imsglobal.org/spec/ob/v3p0/schema/json/ob_v3p0_profile_schema.json';
/** `credentialSchema.type` that tells verifiers to validate against the 1EdTech JSON Schema. */
export const CREDENTIAL_SCHEMA_TYPE = '1EdTechJsonSchemaValidator2019';

/** The Data Integrity cryptosuite credforge signs with. */
export const CRYPTOSUITE = 'eddsa-rdfc-2022';

/** PNG `iTXt` keyword for a baked OB 3.0 credential. */
export const PNG_KEYWORD = 'openbadgecredential';
/** XML namespace for a baked OB 3.0 credential in SVG. */
export const SVG_NAMESPACE = 'https://purl.imsglobal.org/ob/v3p0';

/** Minimum number of entries in a Bitstring Status List (W3C Bitstring Status List v1.0, §3.1). */
export const MIN_STATUS_LIST_LENGTH = 131_072;
