import {
  ACHIEVEMENT_CREDENTIAL_SCHEMA_URL,
  CREDENTIAL_CONTEXT,
  CREDENTIAL_SCHEMA_TYPE,
} from './constants';
import { toDateTimeString } from './dates';
import { buildIssuerRef, type ImageInput, type IssuerInput, toImage } from './issuer-profile';
import { emailIdentifier, nameIdentifier } from './recipient';
import type {
  Achievement,
  Alignment,
  BitstringStatusListEntry,
  Criteria,
  Evidence,
  IdentityObject,
  OpenBadgeCredential,
  Result,
  Url,
} from './types';
import { assertAbsoluteUrl, compact, requireText } from './util';

export interface AlignmentInput {
  targetName: string;
  targetUrl: Url;
  targetDescription?: string;
  targetCode?: string;
  targetFramework?: string;
  /** An `AlignmentTargetType` value such as `CFItem`, or an `ext:` type. */
  targetType?: string;
}

export interface AchievementInput {
  /** The achievement's permanent URL, `{PUBLIC_BASE_URL}/achievements/{uuid}`. */
  id: Url;
  name: string;
  description: string;
  /** What the recipient did to earn it: a narrative (Markdown allowed), a URL, or both. */
  criteria: Criteria;
  /** An `AchievementType` value or an `ext:` type. Defaults to `Badge`. */
  achievementType?: string;
  image?: Url | ImageInput;
  tag?: string[];
  alignment?: AlignmentInput[];
  humanCode?: string;
  fieldOfStudy?: string;
  specialization?: string;
  version?: string;
  inLanguage?: string;
  creditsAvailable?: number;
}

export interface RecipientInput {
  email: string;
  /** Salt for the email hash. Generated when omitted; store it with the credential. */
  salt?: string;
  /** Added as a plain-text `name` identifier. Leave it out to keep the name off the credential. */
  name?: string;
}

export interface EvidenceInput {
  id?: Url;
  name?: string;
  narrative?: string;
  description?: string;
  genre?: string;
  audience?: string;
}

export interface ResultInput {
  /** The `ResultDescription.id` in the achievement that this result answers. */
  resultDescription?: Url;
  achievedLevel?: Url;
  status?: string;
  value?: string;
}

export interface CredentialInput {
  /** The credential's permanent URL, `{PUBLIC_BASE_URL}/credentials/{uuid}`. */
  id: Url;
  issuer: IssuerInput;
  achievement: AchievementInput;
  recipient: RecipientInput;
  validFrom: Date | string;
  validUntil?: Date | string;
  /** Defaults to the achievement name. */
  name?: string;
  description?: string;
  evidence?: EvidenceInput[];
  result?: ResultInput[];
  credentialStatus?: BitstringStatusListEntry;
}

/**
 * Builds an unsigned OpenBadgeCredential (spec B.1.2) in the shape of design plan §5.1. The
 * credential embeds the issuer and achievement as they are now, which is what makes signed
 * credentials immune to later edits.
 */
export function buildCredential(input: CredentialInput): OpenBadgeCredential {
  assertAbsoluteUrl(input.id, 'id');
  const validFrom = toDateTimeString(input.validFrom, 'validFrom');
  const validUntil =
    input.validUntil === undefined ? undefined : toDateTimeString(input.validUntil, 'validUntil');
  if (validUntil !== undefined && validUntil <= validFrom) {
    throw new TypeError('"validUntil" must be later than "validFrom".');
  }
  const achievement = buildAchievement(input.achievement);

  const identifier: IdentityObject[] = [
    emailIdentifier(input.recipient.email, input.recipient.salt),
  ];
  if (input.recipient.name !== undefined) identifier.push(nameIdentifier(input.recipient.name));

  return compact({
    '@context': [...CREDENTIAL_CONTEXT],
    id: input.id,
    type: ['VerifiableCredential', 'OpenBadgeCredential'],
    name: input.name === undefined ? achievement.name : requireText(input.name, 'name'),
    description: input.description,
    issuer: buildIssuerRef(input.issuer),
    validFrom,
    validUntil,
    credentialSubject: compact({
      type: ['AchievementSubject'],
      identifier,
      achievement,
      result: input.result?.map(buildResult),
    }),
    evidence: input.evidence?.map(buildEvidence),
    credentialStatus: input.credentialStatus,
    credentialSchema: [{ id: ACHIEVEMENT_CREDENTIAL_SCHEMA_URL, type: CREDENTIAL_SCHEMA_TYPE }],
  });
}

function buildAchievement(input: AchievementInput): Achievement {
  assertAbsoluteUrl(input.id, 'achievement.id');
  const narrative = input.criteria.narrative?.trim() || undefined;
  if (input.criteria.id !== undefined) assertAbsoluteUrl(input.criteria.id, 'criteria.id');
  if (narrative === undefined && input.criteria.id === undefined) {
    throw new TypeError('"achievement.criteria" needs a narrative or an id (URL).');
  }
  const tag = input.tag?.map((entry) => entry.trim()).filter(Boolean);
  return compact({
    id: input.id,
    type: ['Achievement'],
    achievementType: input.achievementType ?? 'Badge',
    name: requireText(input.name, 'achievement.name'),
    description: requireText(input.description, 'achievement.description'),
    criteria: compact({ id: input.criteria.id, narrative }),
    image: toImage(input.image, 'achievement.image'),
    humanCode: input.humanCode,
    fieldOfStudy: input.fieldOfStudy,
    specialization: input.specialization,
    version: input.version,
    inLanguage: input.inLanguage,
    creditsAvailable: input.creditsAvailable,
    tag: tag?.length ? tag : undefined,
    alignment: input.alignment?.length ? input.alignment.map(buildAlignment) : undefined,
  });
}

function buildAlignment(input: AlignmentInput): Alignment {
  assertAbsoluteUrl(input.targetUrl, 'alignment.targetUrl');
  return compact({
    type: ['Alignment'],
    targetName: requireText(input.targetName, 'alignment.targetName'),
    targetUrl: input.targetUrl,
    targetDescription: input.targetDescription,
    targetCode: input.targetCode,
    targetFramework: input.targetFramework,
    targetType: input.targetType,
  });
}

function buildEvidence(input: EvidenceInput): Evidence {
  if (input.id !== undefined) assertAbsoluteUrl(input.id, 'evidence.id');
  return compact({
    id: input.id,
    type: ['Evidence'],
    name: input.name,
    narrative: input.narrative,
    description: input.description,
    genre: input.genre,
    audience: input.audience,
  });
}

function buildResult(input: ResultInput): Result {
  if (input.resultDescription !== undefined) {
    assertAbsoluteUrl(input.resultDescription, 'result.resultDescription');
  }
  if (input.achievedLevel !== undefined) {
    assertAbsoluteUrl(input.achievedLevel, 'result.achievedLevel');
  }
  return compact({
    type: ['Result'],
    resultDescription: input.resultDescription,
    achievedLevel: input.achievedLevel,
    status: input.status,
    value: input.value,
  });
}
