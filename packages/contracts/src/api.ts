import { z } from 'zod';
import { ORG_ROLES, type OrgRole, type Permission } from './roles';

// ---- shared vocabulary ----

/**
 * Organization lifecycle (design plan §6.3).
 * - `pending`: can set up and test-award to its own members; waits for a platform admin.
 * - `active`: approved (or created where approval isn't required).
 * - `suspended`: stopped by a platform admin; read-only, no issuing or email.
 * - `declined`: not approved; read-only.
 */
export const ORG_STATUSES = ['pending', 'active', 'suspended', 'declined'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const SIGNUP_MODES = ['approval', 'open', 'invite'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

/**
 * Where a signed-in session stands with the credforge second factor (§6.4).
 * - `ok`: nothing to do.
 * - `challenge`: the user has two-step verification but this session hasn't passed it (for
 *   example after Continue with Google). Enter a code first.
 * - `setup`: the user must turn on two-step verification first (owners and admins when
 *   `REQUIRE_MFA_FOR_ADMINS=true`).
 */
export type MfaState = 'ok' | 'challenge' | 'setup';

/** `code` values in RFC 9457 problem responses from `/api/v1`. */
export type ProblemCode =
  | 'unauthenticated'
  | 'email_not_verified'
  | 'mfa_required'
  | 'mfa_setup_required'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'org_inactive'
  | 'last_owner'
  | 'signup_closed'
  | 'invitation_invalid'
  | 'invitation_email_mismatch'
  | 'already_member'
  | 'bad_origin'
  | 'file_too_large'
  | 'unsupported_file'
  | 'issuer_not_ready'
  | 'achievement_not_active'
  | 'recipient_not_allowed'
  | 'send_limit_reached'
  | 'invalid_csv'
  | 'batch_not_draft'
  | 'nothing_to_award'
  | 'already_revoked'
  | 'not_a_credential'
  | 'rate_limited'
  | 'internal_error';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: ProblemCode;
  /** Field errors for `validation_failed`: dotted path → message. */
  errors?: Record<string, string>;
}

// ---- field rules ----

const text = (max: number) =>
  z.string().trim().min(1, 'Required').max(max, `At most ${max} characters`);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters`)
    .transform((value) => (value === '' ? null : value));

export const emailField = z
  .string()
  .trim()
  .max(254, 'At most 254 characters')
  .pipe(z.email('Enter a valid email address'))
  .transform((value) => value.toLowerCase());

/** An absolute http(s) URL, or empty for none. */
const optionalWebUrl = z
  .string()
  .trim()
  .max(2000, 'At most 2000 characters')
  .refine((value) => {
    if (value === '') return true;
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.');
    } catch {
      return false;
    }
  }, 'Enter a full web address, e.g. https://example.org')
  .transform((value) => (value === '' ? null : value));

const optionalEmail = z
  .string()
  .trim()
  .max(254, 'At most 254 characters')
  .refine(
    (value) => value === '' || z.email().safeParse(value).success,
    'Enter a valid email address',
  )
  .transform((value) => (value === '' ? null : value.toLowerCase()));

// ---- request bodies ----

export const createOrgInput = z.object({ name: text(120) });
export type CreateOrgInput = z.input<typeof createOrgInput>;

export const updateOrgInput = z.object({ name: text(120) });
export type UpdateOrgInput = z.input<typeof updateOrgInput>;

export const orgRoleField = z.enum(ORG_ROLES, { error: 'Choose a role' });

export const inviteMemberInput = z.object({ email: emailField, role: orgRoleField });
export type InviteMemberInput = z.input<typeof inviteMemberInput>;

export const updateMemberInput = z.object({ role: orgRoleField });
export type UpdateMemberInput = z.input<typeof updateMemberInput>;

export const issuerInput = z.object({
  name: text(200),
  url: optionalWebUrl.optional(),
  email: optionalEmail.optional(),
  description: optionalText(2000).optional(),
});
export type IssuerInputBody = z.input<typeof issuerInput>;

export const updateIssuerInput = issuerInput.partial();
export type UpdateIssuerInput = z.input<typeof updateIssuerInput>;

export const platformDecisionInput = z.object({ reason: optionalText(1000).optional() });
export type PlatformDecisionInput = z.input<typeof platformDecisionInput>;

export const platformOrgsQuery = z.object({ status: z.enum(ORG_STATUSES).optional() });

/** `null` goes back to the instance default; 0 means no limit. */
export const platformOrgLimitsInput = z.object({
  dailySendLimit: z
    .number({ error: 'Enter a whole number' })
    .int('Enter a whole number')
    .min(0, 'Can’t be negative')
    .max(1_000_000, 'At most 1,000,000')
    .nullable(),
});
export type PlatformOrgLimitsInput = z.input<typeof platformOrgLimitsInput>;

// ---- achievements ----

/** OB 3.0 `AchievementType` values (spec B.2.1). `ext:` types are allowed too. */
export const ACHIEVEMENT_TYPES = [
  'Achievement',
  'ApprenticeshipCertificate',
  'Assessment',
  'Assignment',
  'AssociateDegree',
  'Award',
  'Badge',
  'BachelorDegree',
  'Certificate',
  'CertificateOfCompletion',
  'Certification',
  'CommunityService',
  'Competency',
  'Course',
  'CoCurricular',
  'Degree',
  'Diploma',
  'DoctoralDegree',
  'Fieldwork',
  'GeneralEducationDevelopment',
  'JourneymanCertificate',
  'LearningProgram',
  'License',
  'Membership',
  'ProfessionalDoctorate',
  'QualityAssuranceCredential',
  'MasterCertificate',
  'MasterDegree',
  'MicroCredential',
  'ResearchDoctorate',
  'SecondarySchoolDiploma',
] as const;

/** OB 3.0 `AlignmentTargetType` values (spec B.2.2). */
export const ALIGNMENT_TARGET_TYPES = [
  'ceasn:Competency',
  'ceterms:Credential',
  'CFItem',
  'CFRubric',
  'CFRubricCriterion',
  'CFRubricCriterionLevel',
  'CTDL',
] as const;

/** Human labels for the achievement types, e.g. `CertificateOfCompletion` → `Certificate of completion`. */
export function achievementTypeLabel(type: string): string {
  if (type.startsWith('ext:')) return type.slice(4);
  const words = type
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const EXTENSION_TYPE = /^ext:[A-Za-z0-9.\-_|]+$/;

export const achievementTypeField = z
  .string()
  .trim()
  .refine(
    (value) =>
      (ACHIEVEMENT_TYPES as readonly string[]).includes(value) || EXTENSION_TYPE.test(value),
    'Choose a type',
  );

/** An absolute http(s) URL. */
const webUrl = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(2000, 'At most 2000 characters')
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.');
    } catch {
      return false;
    }
  }, 'Enter a full web address, e.g. https://example.org');

export const alignmentInput = z.object({
  targetName: text(200),
  targetUrl: webUrl,
  targetDescription: optionalText(1000).optional(),
  targetFramework: optionalText(200).optional(),
  targetCode: optionalText(100).optional(),
  targetType: z
    .string()
    .trim()
    .refine(
      (value) =>
        value === '' ||
        (ALIGNMENT_TARGET_TYPES as readonly string[]).includes(value) ||
        EXTENSION_TYPE.test(value),
      'Choose a type',
    )
    .transform((value) => (value === '' ? null : value))
    .optional(),
});
export type AlignmentInput = z.input<typeof alignmentInput>;

const tag = z.string().trim().min(1).max(60, 'Each tag can have at most 60 characters');

const achievementFields = {
  name: text(200),
  description: text(4000),
  /** What the recipient did to earn it. Markdown is allowed (OB 3.0 `Criteria.narrative`). */
  criteriaNarrative: optionalText(10_000).optional(),
  /** A page that describes the criteria. */
  criteriaUrl: optionalWebUrl.optional(),
  achievementType: achievementTypeField.optional(),
  tags: z
    .array(tag)
    .max(20, 'At most 20 tags')
    .transform((tags) => [...new Set(tags)])
    .optional(),
  alignments: z.array(alignmentInput).max(20, 'At most 20 alignments').optional(),
  /** Credentials expire this many days after they are issued; null means they don't expire. */
  validForDays: z
    .number({ error: 'Enter a number of days' })
    .int('Enter a whole number of days')
    .min(1, 'At least 1 day')
    .max(36_500, 'At most 100 years')
    .nullable()
    .optional(),
};

function requireCriteria(
  value: { criteriaNarrative?: string | null; criteriaUrl?: string | null },
  ctx: z.RefinementCtx,
) {
  if (!value.criteriaNarrative && !value.criteriaUrl) {
    ctx.addIssue({
      code: 'custom',
      path: ['criteriaNarrative'],
      message: 'Describe how it is earned, or link to a page that does',
    });
  }
}

export const achievementInput = z.object(achievementFields).superRefine(requireCriteria);
export type AchievementInputBody = z.input<typeof achievementInput>;

/** A partial update. The criteria rule is checked against the merged result on the server. */
export const updateAchievementInput = z.object(achievementFields).partial();
export type UpdateAchievementInput = z.input<typeof updateAchievementInput>;

export const ACHIEVEMENT_STATUSES = ['draft', 'active', 'archived'] as const;
export type AchievementStatus = (typeof ACHIEVEMENT_STATUSES)[number];

export const achievementsQuery = z.object({ status: z.enum(ACHIEVEMENT_STATUSES).optional() });

// ---- awarding ----

export const evidenceInput = z
  .object({
    url: optionalWebUrl.optional(),
    name: optionalText(200).optional(),
    narrative: optionalText(4000).optional(),
  })
  .refine((value) => value.url || value.narrative, {
    path: ['url'],
    message: 'Add a link or a description',
  });
export type EvidenceInput = z.input<typeof evidenceInput>;

/** A calendar date (`2026-11-02`) or a full ISO 8601 date-time. */
const dateField = z
  .string()
  .trim()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(value) &&
      !Number.isNaN(new Date(value).getTime()),
    'Enter a date',
  );

export const awardInput = z.object({
  achievementId: z.uuid('Choose an achievement'),
  recipient: z.object({
    name: text(200),
    email: emailField,
  }),
  /** When it was earned (the credential's `validFrom`). Defaults to now; can't be in the future. */
  issuedOn: dateField.optional(),
  /** Expiry (the credential's `validUntil`); defaults to the achievement's validity, if any. */
  expiresOn: dateField.nullable().optional(),
  evidence: z.array(evidenceInput).max(5, 'At most 5 pieces of evidence').optional(),
  /** Email the recipient their claim link (default true). */
  sendEmail: z.boolean().optional(),
});
export type AwardInput = z.input<typeof awardInput>;

/**
 * Where a credential stands for its holder: computed from its status and dates ("expired" is
 * never stored).
 */
export const CREDENTIAL_STATES = ['valid', 'not_yet_valid', 'expired', 'revoked'] as const;
export type CredentialState = (typeof CREDENTIAL_STATES)[number];

/** A calendar date, `2026-11-02`. */
const calendarDate = z
  .string()
  .trim()
  .refine(
    (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value).getTime()),
    'Enter a date as YYYY-MM-DD',
  );

/** Search and filters shared by the credentials list and the exports (design plan §11.1). */
export const credentialFilters = z.object({
  /** Part of the recipient's name or email address. */
  q: z.string().trim().max(200).optional(),
  achievementId: z.uuid().optional(),
  /** `valid` includes credentials that aren't valid yet only when asked for `not_yet_valid`. */
  status: z.enum(CREDENTIAL_STATES).optional(),
  batchId: z.uuid().optional(),
  /** Awarded on or after this day (UTC). */
  from: calendarDate.optional(),
  /** Awarded on or before this day (UTC). */
  to: calendarDate.optional(),
});
export type CredentialFilters = z.input<typeof credentialFilters>;

export const credentialsQuery = credentialFilters.extend({
  /** Cursor: the `next` value from the previous page. */
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// ---- revoking and reissuing (design plan §8.6) ----

export const revokeInput = z.object({
  /** Why, for the organization's records. Never shown publicly. */
  reason: text(1000),
  /** Shown on the badge's public page. */
  publicReason: optionalText(500).optional(),
});
export type RevokeInput = z.input<typeof revokeInput>;

export const bulkRevokeInput = revokeInput.extend({
  credentialIds: z
    .array(z.uuid())
    .min(1, 'Choose at least one badge')
    .max(500, 'At most 500 at a time')
    .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]),
});
export type BulkRevokeInput = z.input<typeof bulkRevokeInput>;

export interface BulkRevokeResult {
  revoked: string[];
  /** Already revoked before this request; left as they were. */
  alreadyRevoked: string[];
  notFound: string[];
}

/**
 * A corrected copy. Anything left out is copied from the credential being replaced; the
 * achievement is signed as it is now.
 */
export const reissueInput = z.object({
  recipient: z.object({ name: text(200).optional(), email: emailField.optional() }).optional(),
  issuedOn: dateField.optional(),
  expiresOn: dateField.nullable().optional(),
  evidence: z.array(evidenceInput).max(5, 'At most 5 pieces of evidence').optional(),
  /** Email the recipient the corrected badge (default true). */
  sendEmail: z.boolean().optional(),
  /** Why, for the organization's records. */
  reason: optionalText(1000).optional(),
});
export type ReissueInput = z.input<typeof reissueInput>;

// ---- batches: award many (design plan §8.3) ----

export const BATCH_LIMITS = {
  /** Data rows in one file. */
  maxRows: 10_000,
  /** Size of one uploaded file. */
  maxBytes: 5 * 1024 * 1024,
  maxColumns: 50,
  /** Characters in one cell. */
  maxCell: 2000,
  /** Custom fields kept per row. */
  maxCustomFields: 20,
} as const;

export const BATCH_COLUMN_TARGETS = [
  'name',
  'firstName',
  'lastName',
  'email',
  'issuedOn',
  'expiresOn',
  'evidenceUrl',
  'custom',
  'ignore',
] as const;
export type BatchColumnTarget = (typeof BATCH_COLUMN_TARGETS)[number];

export const BATCH_COLUMN_LABELS: Record<BatchColumnTarget, string> = {
  name: 'Full name',
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  issuedOn: 'Award date',
  expiresOn: 'Expiry date',
  evidenceUrl: 'Evidence link',
  custom: 'Keep as a custom field',
  ignore: 'Don’t use',
};

export const BATCH_STATUSES = ['draft', 'queued', 'running', 'completed', 'failed'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export const BATCH_ROW_VALIDATIONS = ['ready', 'invalid', 'duplicate', 'existing'] as const;
export type BatchRowValidation = (typeof BATCH_ROW_VALIDATIONS)[number];
export const BATCH_ROW_STATUSES = ['draft', 'pending', 'issued', 'failed', 'skipped'] as const;
export type BatchRowStatus = (typeof BATCH_ROW_STATUSES)[number];

/** Changes to a draft batch: its achievement, how to read the file, and what to do. */
export const updateBatchInput = z.object({
  achievementId: z.uuid('Choose an achievement').optional(),
  hasHeader: z.boolean().optional(),
  /** One target per column, in the file's order. */
  columns: z.array(z.enum(BATCH_COLUMN_TARGETS)).max(BATCH_LIMITS.maxColumns).optional(),
  sendEmail: z.boolean().optional(),
  awardExisting: z.boolean().optional(),
});
export type UpdateBatchInput = z.input<typeof updateBatchInput>;

const batchCell = z
  .string()
  .max(BATCH_LIMITS.maxCell, `At most ${BATCH_LIMITS.maxCell} characters`);

/** A batch from JSON rows (the API's alternative to a CSV file). Rows are checked like a file's. */
export const createBatchFromRowsInput = z.object({
  achievementId: z.uuid('Choose an achievement'),
  rows: z
    .array(
      z.object({
        name: batchCell,
        email: batchCell,
        issuedOn: batchCell.optional(),
        expiresOn: batchCell.optional(),
        evidenceUrl: batchCell.optional(),
        custom: z.record(z.string().max(100), batchCell).optional(),
      }),
    )
    .min(1, 'Add at least one row')
    .max(BATCH_LIMITS.maxRows, `At most ${BATCH_LIMITS.maxRows.toLocaleString('en-US')} rows`),
  sendEmail: z.boolean().optional(),
  awardExisting: z.boolean().optional(),
});
export type CreateBatchFromRowsInput = z.input<typeof createBatchFromRowsInput>;

export const batchesQuery = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const batchRowsQuery = z.object({
  validation: z.enum(BATCH_ROW_VALIDATIONS).optional(),
  status: z.enum(BATCH_ROW_STATUSES).optional(),
  /** Cursor: the `next` row number from the previous page. */
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// ---- verify (design plan §8.5) ----

/** Exactly one of `url`, `credential` or `image`. */
export const verifyInput = z
  .object({
    /** A credential's address, or the address of a baked badge image. */
    url: z.string().trim().max(2000).optional(),
    /** The credential itself, as an object or as JSON text. */
    credential: z.union([z.record(z.string(), z.unknown()), z.string().max(1_000_000)]).optional(),
    /** A baked PNG or SVG badge, base64-encoded (a data: URL is fine). */
    image: z.string().max(8_000_000).optional(),
    /** Optional: check the credential was issued to this address. It is never stored. */
    email: z.string().trim().max(254).optional(),
  })
  .refine(
    (value) =>
      [value.url, value.credential, value.image].filter((part) => part !== undefined && part !== '')
        .length === 1,
    { message: 'Give a URL, the credential’s JSON, or a badge image', path: ['url'] },
  );
export type VerifyInput = z.input<typeof verifyInput>;

export const auditEventsQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---- responses ----

export interface InstanceInfo {
  signupMode: SignupMode;
  providers: { google: boolean; microsoft: boolean };
  requireMfaForAdmins: boolean;
}

export interface OrgSummary {
  id: string;
  name: string;
  status: OrgStatus;
  statusReason: string | null;
  createdAt: string;
}

export interface Membership {
  org: OrgSummary;
  role: OrgRole;
}

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  isPlatformAdmin: boolean;
  twoFactorEnabled: boolean;
}

/** `credential` (password), `google` or `microsoft`. */
export type SignInProvider = 'credential' | 'google' | 'microsoft' | (string & {});

export interface SignInMethod {
  /** The account id, for disconnecting it (Better Auth `unlinkAccount`). */
  id: string;
  provider: SignInProvider;
}

export interface MeResponse {
  user: CurrentUser;
  mfa: { state: MfaState; required: boolean };
  /** How this user can sign in. Turning on two-step verification asks for the password if there is one. */
  signInMethods: SignInMethod[];
  memberships: Membership[];
  /** Pending invitations to this user's verified email address. */
  invitations: InvitationForRecipient[];
}

export interface OrgDetails extends OrgSummary {
  role: OrgRole;
  permissions: Permission[];
  approvedAt: string | null;
  /** Award emails it may send in any 24 hours; null means no limit. */
  dailySendLimit: number | null;
}

export interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  twoFactorEnabled: boolean;
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: OrgRole;
  invitedBy: { id: string; name: string } | null;
  expiresAt: string;
  createdAt: string;
}

export interface InvitationForRecipient {
  id: string;
  org: { id: string; name: string };
  role: OrgRole;
  invitedByName: string | null;
  expiresAt: string;
}

/** What `/invite/{token}` shows before the person signs in. */
export interface InvitationPreview extends InvitationForRecipient {
  email: string;
}

export interface SigningKeySummary {
  id: string;
  algorithm: 'Ed25519';
  publicKeyMultibase: string;
  status: 'active' | 'retired' | 'revoked';
  createdAt: string;
}

/**
 * An uploaded image and its derived sizes. Every URL is permanent and content-addressed
 * (design plan §5.4): `{PUBLIC_BASE_URL}/achievements/{id}/images/{sha256}.png` and so on.
 */
export interface ImageSet {
  /** The cleaned original (PNG or SVG): the image in credentials and for baking. */
  url: string;
  /** 512 px PNG, for pages and emails. */
  url512: string;
  /** 128 px PNG, for lists. */
  url128: string;
  /** 1200×630 Open Graph card (badge images only). */
  ogUrl: string | null;
  mimeType: 'image/png' | 'image/svg+xml';
  width: number | null;
  height: number | null;
}

export interface Issuer {
  id: string;
  /** The permanent issuer id embedded in credentials: `{PUBLIC_BASE_URL}/issuers/{id}`. */
  url: string;
  name: string;
  website: string | null;
  email: string | null;
  description: string | null;
  logo: ImageSet | null;
  keys: SigningKeySummary[];
  createdAt: string;
  updatedAt: string;
}

export interface PlatformOrg extends OrgSummary {
  approvedAt: string | null;
  requestedBy: { name: string; email: string } | null;
  memberCount: number;
  issuers: { id: string; name: string; website: string | null }[];
  /** This org's own limit; null uses the instance default. */
  dailySendLimit: number | null;
  /** The instance default (DEFAULT_ORG_DAILY_SEND_LIMIT); 0 means no limit. */
  defaultDailySendLimit: number;
}

export interface Alignment {
  targetName: string;
  targetUrl: string;
  targetDescription: string | null;
  targetFramework: string | null;
  targetCode: string | null;
  targetType: string | null;
}

export interface Achievement {
  id: string;
  /** The permanent id embedded in credentials: `{PUBLIC_BASE_URL}/achievements/{id}`. */
  url: string;
  issuerId: string;
  name: string;
  description: string;
  criteriaNarrative: string | null;
  criteriaUrl: string | null;
  achievementType: string;
  tags: string[];
  alignments: Alignment[];
  validForDays: number | null;
  image: ImageSet | null;
  /** Increases with every saved change; credentials record the revision they were issued with. */
  revision: number;
  status: AchievementStatus;
  /** Credentials issued from it. */
  awardedCount: number;
  publishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AchievementRevision {
  revision: number;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
}

/**
 * Where a credential's email stands (design plan §8.4). `not_sent` when the award was made
 * without email.
 */
export type DeliveryStatus =
  | 'not_sent'
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'dropped'
  | 'spam_reported'
  | 'failed';

export interface EmailDelivery {
  id: string;
  kind: string;
  to: string;
  status: Exclude<DeliveryStatus, 'not_sent'>;
  attempts: number;
  lastError: string | null;
  events: { event: string; at: string; reason?: string }[];
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  bouncedAt: string | null;
}

export interface Revocation {
  /** `superseded` when a corrected copy replaced it. */
  kind: 'revoked' | 'superseded';
  at: string;
  /** For the organization only. */
  reason: string | null;
  /** Shown on the public page. */
  publicReason: string | null;
}

export interface CredentialSummary {
  id: string;
  /** The credential's permanent public URL. */
  url: string;
  achievement: { id: string; name: string; revision: number; image128: string | null };
  recipient: { name: string; email: string };
  status: 'draft' | 'issued' | 'revoked';
  /** From the status and the dates: valid, not valid yet, expired or revoked. */
  state: CredentialState;
  validFrom: string;
  validUntil: string | null;
  visibility: 'public' | 'hidden';
  /** When the recipient first opened their claim link. */
  acceptedAt: string | null;
  delivery: DeliveryStatus;
  revocation: Revocation | null;
  /** The batch that awarded it, if any. */
  batchId: string | null;
  /** The corrected copy that replaced it, and the credential it corrects. */
  replacedById: string | null;
  replacesId: string | null;
  createdAt: string;
}

export interface CredentialDetails extends CredentialSummary {
  issuedBy: { type: 'user' | 'api_key'; id: string | null; label: string | null };
  /** Until when the latest claim link works; null if none was sent. */
  claimLinkExpiresAt: string | null;
  emails: EmailDelivery[];
  /** Extra columns kept from a CSV batch (not signed, not public). */
  customFields: Record<string, string>;
  /** Evidence as signed into the credential. */
  evidence: { url: string | null; name: string | null; narrative: string | null }[];
  /** Who revoked it, from the audit log. */
  revokedBy: { label: string | null } | null;
  /** The signed OB 3.0 credential. */
  document: Record<string, unknown>;
}

export interface CredentialPage {
  credentials: CredentialSummary[];
  /** Pass as `before` for the next (older) page; null on the last page. */
  next: string | null;
}

/** What the recipient's email will say (POST /credentials/preview). */
export interface AwardPreview {
  email: { subject: string; text: string; from: string; replyTo: string | null };
}

export interface BatchCounts {
  /** Checking the file (any status). */
  ready: number;
  invalid: number;
  duplicate: number;
  existing: number;
  /** Issuing (after confirming). */
  pending: number;
  issued: number;
  failed: number;
  skipped: number;
}

export interface BatchSummary {
  id: string;
  achievement: { id: string; name: string };
  source: 'csv' | 'api';
  fileName: string | null;
  status: BatchStatus;
  totalRows: number;
  counts: BatchCounts;
  options: { sendEmail: boolean; awardExisting: boolean };
  createdBy: { type: 'user' | 'api_key'; id: string | null; label: string | null };
  /** Why a `failed` batch stopped. */
  error: string | null;
  createdAt: string;
  confirmedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BatchColumnInfo {
  /** The column's name from the file (or "Column 3" when the file has no header line). */
  header: string;
  target: BatchColumnTarget;
  /** The first few values, for the mapping step. */
  samples: string[];
}

export interface BatchDetails extends BatchSummary {
  hasHeader: boolean;
  columns: BatchColumnInfo[];
  /** What confirming would do now (drafts), or did (after). */
  plan: {
    /** Rows that will be awarded. */
    toAward: number;
    /** Rows that will be skipped: invalid, duplicates, and existing holders unless awarded again. */
    toSkip: number;
    /** Emails it will send. */
    emails: number;
    /**
     * The org's daily email cap: its limit (null: none) and how many it can still send in the
     * next 24 hours (null: no limit).
     */
    sendLimit: { limit: number | null; remaining: number | null };
  };
}

export interface BatchRow {
  rowNumber: number;
  values: {
    name: string;
    email: string;
    issuedOn?: string;
    expiresOn?: string;
    evidenceUrl?: string;
    custom: Record<string, string>;
  } | null;
  validation: BatchRowValidation;
  issues: { field: string; message: string }[];
  status: BatchRowStatus;
  credential: { id: string; url: string } | null;
  error: { code: string; message: string } | null;
}

export interface BatchPage {
  batches: BatchSummary[];
  next: string | null;
}

export interface BatchRowPage {
  rows: BatchRow[];
  /** Pass as `after` for the next page; null on the last page. */
  next: number | null;
}

export type VerifyCheckOutcome = 'passed' | 'failed' | 'skipped';

export interface VerifyCheck {
  outcome: VerifyCheckOutcome;
  /** Plain, factual wording ("Signature checked …"), never "guaranteed". */
  message: string;
  details?: string[];
}

/** The result of `POST /api/v1/verify` (design plan §8.5). Nothing about the request is stored. */
export interface VerifyResult {
  /** Format, signature and dates passed, and the status check didn't fail. */
  verified: boolean;
  /** When the checks ran; the status list was read then. */
  checkedAt: string;
  /** What was checked: a URL's JSON, pasted JSON, or a baked image. */
  source: 'url' | 'json' | 'png' | 'svg';
  /** What the credential says, for display. Null when it isn't readable as one. */
  credential: {
    id: string | null;
    name: string | null;
    achievement: { id: string | null; name: string | null; description: string | null };
    issuer: { id: string | null; name: string | null; url: string | null };
    recipientName: string | null;
    validFrom: string | null;
    validUntil: string | null;
    /** Whether the issuer is this credforge instance. */
    issuedHere: boolean;
  } | null;
  checks: {
    format: VerifyCheck;
    proof: VerifyCheck;
    status: VerifyCheck;
    validity: VerifyCheck;
    /** Only when an email address was given. */
    recipient?: VerifyCheck;
  };
}

export interface AuditEvent {
  id: number;
  action: string;
  actor: {
    type: 'user' | 'system' | 'api_key' | 'recipient';
    id: string | null;
    label: string | null;
  };
  target: { type: string; id: string } | null;
  data: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export interface AuditEventPage {
  events: AuditEvent[];
  /** Pass as `before` to get the next (older) page; null on the last page. */
  next: number | null;
}
