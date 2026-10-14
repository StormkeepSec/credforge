import { buildCredential, type CredentialInput } from './credential';
import { signCredential, verifyProof } from './proof';
import type { Signer } from './signer';
import { buildStatusListCredential, type StatusListCredentialInput } from './status-list';
import type {
  IssuerProfileDocument,
  SignedBitstringStatusListCredential,
  SignedOpenBadgeCredential,
} from './types';
import { checkFormat } from './verify';

/** Thrown when a freshly signed document fails its own verification. Nothing should be stored. */
export class SelfCheckError extends Error {
  readonly problems: string[];

  constructor(what: string, problems: string[]) {
    super(`The ${what} failed its self-check: ${problems.join('; ')}`);
    this.name = 'SelfCheckError';
    this.problems = problems;
  }
}

export interface IssueOptions {
  signer: Signer;
  /**
   * The issuer profile as currently published. The self-check verifies against it, which also
   * proves that the signing key is listed in its `assertionMethod`.
   */
  issuerProfile: IssuerProfileDocument;
  /** The proof's `created` time. Defaults to now. */
  created?: Date | string;
}

/**
 * Builds, signs and self-checks an OpenBadgeCredential: the signed credential must validate
 * against the official JSON Schema and verify against the published issuer profile before it is
 * returned (design plan §5.2). A signing bug therefore fails loudly.
 */
export async function issueCredential(
  input: CredentialInput,
  options: IssueOptions,
): Promise<SignedOpenBadgeCredential> {
  const credential = buildCredential(input);
  const unsignedFormat = checkFormat(credential);
  if (unsignedFormat.outcome !== 'passed') {
    throw new SelfCheckError('credential', unsignedFormat.details ?? [unsignedFormat.message]);
  }
  const signed = await signCredential(credential, options.signer, { created: options.created });
  await selfCheck('credential', signed, options.issuerProfile, true);
  return signed;
}

/** Builds, signs and self-checks a BitstringStatusListCredential. */
export async function issueStatusListCredential(
  input: StatusListCredentialInput,
  options: IssueOptions,
): Promise<SignedBitstringStatusListCredential> {
  const statusList = buildStatusListCredential(input);
  const signed = await signCredential(statusList, options.signer, { created: options.created });
  await selfCheck('status list credential', signed, options.issuerProfile, false);
  return signed;
}

async function selfCheck(
  what: string,
  document: object,
  issuerProfile: IssuerProfileDocument,
  checkSchema: boolean,
): Promise<void> {
  const problems: string[] = [];
  if (checkSchema) {
    const format = checkFormat(document);
    if (format.outcome !== 'passed') problems.push(...(format.details ?? [format.message]));
  }
  const proof = await verifyProof(document, { controller: issuerProfile });
  if (!proof.verified) problems.push(...proof.errors);
  if (problems.length > 0) throw new SelfCheckError(what, problems);
}
