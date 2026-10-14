import { asArray, isRecord } from './document-loader';
import { verifyProof } from './proof';
import { validateCredentialSchema } from './schema';
import { checkStatusListEntry } from './status-list';

export type CheckOutcome = 'passed' | 'failed' | 'skipped';

export interface Check {
  outcome: CheckOutcome;
  /** Plain, factual wording suitable for the verification panel. */
  message: string;
  details?: string[];
}

export interface CredentialVerification {
  /** True when format, proof and validity passed and the status check did not fail. */
  verified: boolean;
  checks: {
    /** Format: official OB 3.0 JSON Schema plus the §9.1 rules the schema can't express. */
    format: Check;
    /** Signature by a key the issuer publishes for assertions. */
    proof: Check;
    /** Not revoked or suspended. Skipped when there is no status entry or no loader. */
    status: Check;
    /** The current time is within validFrom/validUntil. */
    validity: Check;
  };
}

export interface VerifyCredentialOptions {
  /**
   * Returns the controller document (issuer profile) for a controller id, the part of
   * `proof.verificationMethod` before `#`. The caller decides where it comes from: credforge's own
   * database for its issuers, or an HTTPS fetch for others.
   */
  resolveController: (id: string) => unknown | Promise<unknown>;
  /** Returns the status list credential at a URL. Without it the status check is skipped. */
  loadStatusListCredential?: (url: string) => unknown | Promise<unknown>;
  /** Defaults to now. */
  now?: Date;
}

/** Verifies an OpenBadgeCredential following OB 3.0 §9.1, reporting each check separately. */
export async function verifyCredential(
  credential: unknown,
  options: VerifyCredentialOptions,
): Promise<CredentialVerification> {
  const now = options.now ?? new Date();
  const format = checkFormat(credential);
  const proof = await checkProof(credential, options);
  const status = await checkStatus(credential, options, now);
  const validity = checkValidity(credential, now);
  const verified =
    format.outcome === 'passed' &&
    proof.outcome === 'passed' &&
    validity.outcome === 'passed' &&
    status.outcome !== 'failed';
  return { verified, checks: { format, proof, status, validity } };
}

export function checkFormat(credential: unknown): Check {
  const errors = validateCredentialSchema(credential).errors;
  if (isRecord(credential)) {
    const types = asArray(credential.type);
    if (!types.includes('OpenBadgeCredential') && !types.includes('AchievementCredential')) {
      errors.push('/type must include "OpenBadgeCredential" or "AchievementCredential"');
    }
    const subject = asArray(credential.credentialSubject)[0];
    if (!isRecord(subject) || (subject.id === undefined && subject.identifier === undefined)) {
      errors.push('/credentialSubject must have an id or an identifier (OB 3.0 §9.1)');
    }
  }
  if (errors.length > 0) {
    return {
      outcome: 'failed',
      message: 'Not a valid Open Badges 3.0 credential',
      details: errors,
    };
  }
  return { outcome: 'passed', message: 'Format and schema are valid' };
}

async function checkProof(credential: unknown, options: VerifyCredentialOptions): Promise<Check> {
  const controllerId = controllerIdOf(credential);
  if (controllerId === undefined) {
    return { outcome: 'failed', message: 'No usable proof found' };
  }
  const controller = await resolve(options.resolveController, controllerId);
  if (controller === undefined) {
    return { outcome: 'failed', message: `Could not load the issuer profile at ${controllerId}` };
  }
  const result = await verifyProof(credential, { controller });
  if (!result.verified) {
    return { outcome: 'failed', message: 'Signature check failed', details: result.errors };
  }
  return { outcome: 'passed', message: 'Signature checked with a key published by the issuer' };
}

async function checkStatus(
  credential: unknown,
  options: VerifyCredentialOptions,
  now: Date,
): Promise<Check> {
  const entries = isRecord(credential) ? asArray(credential.credentialStatus) : [];
  if (entries.length === 0) return { outcome: 'skipped', message: 'No status information' };
  if (!options.loadStatusListCredential) {
    return { outcome: 'skipped', message: 'Status not checked' };
  }

  const issuer = isRecord(credential) ? issuerIdOf(credential.issuer) : undefined;
  const states = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== 'BitstringStatusListEntry') {
      return { outcome: 'failed', message: 'Unsupported status method' };
    }
    const url = entry.statusListCredential;
    if (typeof url !== 'string') {
      return { outcome: 'failed', message: 'The status entry has no statusListCredential' };
    }
    const statusList = await resolve(options.loadStatusListCredential, url);
    if (statusList === undefined) {
      return { outcome: 'failed', message: `Could not load the status list at ${url}` };
    }
    const listController = controllerIdOf(statusList);
    const controller =
      listController === undefined
        ? undefined
        : await resolve(options.resolveController, listController);
    if (controller === undefined) {
      return {
        outcome: 'failed',
        message: 'Could not load the issuer profile for the status list',
      };
    }
    const result = await checkStatusListEntry(entry, statusList, {
      controller,
      expectedIssuer: issuer,
      now,
    });
    if (!result.ok) {
      return { outcome: 'failed', message: 'Status could not be checked', details: result.errors };
    }
    const word = result.purpose === 'revocation' ? 'revoked' : 'suspended';
    if (result.set) return { outcome: 'failed', message: `The issuer has ${word} this credential` };
    states.add(word);
  }
  return {
    outcome: 'passed',
    message: `Not ${[...states].join(' or ')} (status list checked at ${now.toISOString().slice(0, 19)}Z)`,
  };
}

export function checkValidity(credential: unknown, now = new Date()): Check {
  if (!isRecord(credential) || typeof credential.validFrom !== 'string') {
    return { outcome: 'failed', message: 'The credential has no validFrom date' };
  }
  const validFrom = new Date(credential.validFrom);
  if (Number.isNaN(validFrom.getTime())) {
    return { outcome: 'failed', message: 'validFrom is not a valid date' };
  }
  if (now < validFrom) {
    return { outcome: 'failed', message: `Not valid until ${credential.validFrom}` };
  }
  if (typeof credential.validUntil === 'string') {
    const validUntil = new Date(credential.validUntil);
    if (Number.isNaN(validUntil.getTime())) {
      return { outcome: 'failed', message: 'validUntil is not a valid date' };
    }
    if (now > validUntil) {
      return { outcome: 'failed', message: `Expired on ${credential.validUntil}` };
    }
    return { outcome: 'passed', message: `Valid until ${credential.validUntil}` };
  }
  return { outcome: 'passed', message: `Valid since ${credential.validFrom}` };
}

/** The controller id from the first proof's verification method (the part before `#`). */
export function controllerIdOf(document: unknown): string | undefined {
  if (!isRecord(document)) return undefined;
  const proof = asArray(document.proof)[0];
  if (!isRecord(proof)) return undefined;
  const method = isRecord(proof.verificationMethod)
    ? proof.verificationMethod.id
    : proof.verificationMethod;
  if (typeof method !== 'string' || !method) return undefined;
  const hash = method.indexOf('#');
  return hash === -1 ? method : method.slice(0, hash);
}

function issuerIdOf(issuer: unknown): string | undefined {
  if (typeof issuer === 'string') return issuer;
  return isRecord(issuer) && typeof issuer.id === 'string' ? issuer.id : undefined;
}

async function resolve(
  fn: (id: string) => unknown | Promise<unknown>,
  id: string,
): Promise<unknown | undefined> {
  try {
    return (await fn(id)) ?? undefined;
  } catch {
    return undefined;
  }
}
