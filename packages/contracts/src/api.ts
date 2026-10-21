import { z } from 'zod';
import {
  API_KEY_SCOPES,
  type ApiKeyScope,
  ORG_ROLES,
  type OrgRole,
  type Permission,
} from './roles';

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
  | 'already_erased'
  | 'credential_erased'
  | 'not_a_credential'
  | 'rate_limited'
  | 'api_key_not_allowed'
  | 'no_website'
  | 'email_confirmation_invalid'
  | 'content_in_review'
  | 'content_removed'
  | 'removed_by_platform'
  | 'storage_quota_exceeded'
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

export const platformDecisionInput = z.object({
  reason: optionalText(1000).optional(),
  /**
   * Approving: the items waiting for review that the admin looked at, cleared with the approval
   * (design plan §6.5). Items saved after the admin loaded the queue keep waiting.
   */
  clearItemIds: z.array(z.uuid()).max(500).optional(),
});
export type PlatformDecisionInput = z.input<typeof platformDecisionInput>;

export const platformOrgsQuery = z.object({ status: z.enum(ORG_STATUSES).optional() });

const orgLimit = (max: number, maxLabel: string) =>
  z
    .number({ error: 'Enter a whole number' })
    .int('Enter a whole number')
    .min(0, 'Can’t be negative')
    .max(max, `At most ${maxLabel}`)
    .nullable()
    .optional();

/** Each limit: `null` goes back to the instance default, 0 means no limit, left out stays. */
export const platformOrgLimitsInput = z.object({
  dailySendLimit: orgLimit(1_000_000, '1,000,000'),
  /** Image and CSV uploads per hour (design plan §6.5). */
  uploadRateLimit: orgLimit(100_000, '100,000'),
  /** Stored files, in MB. */
  storageQuotaMb: orgLimit(1_000_000, '1,000,000'),
});
export type PlatformOrgLimitsInput = z.input<typeof platformOrgLimitsInput>;

// ---- moderation (design plan §6.5) ----

/**
 * Where a piece of public content stands: `pending` waits for a platform admin and isn't served
 * publicly, `cleared` is published, `removed` was taken down by a platform admin.
 */
export const MODERATION_STATUSES = ['pending', 'cleared', 'removed'] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

/** What a report from a public page is about. */
export const REPORT_CATEGORIES = [
  'child_safety',
  'sexual_content',
  'hate_harassment',
  'violence',
  'impersonation',
  'scam_phishing',
  'personal_data',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  child_safety: 'Child sexual abuse or exploitation of a child',
  sexual_content: 'Sexual or pornographic content',
  hate_harassment: 'Hate, harassment or threats',
  violence: 'Violent or graphic content',
  impersonation: 'Impersonation or a fake badge',
  scam_phishing: 'Scam, phishing or spam',
  personal_data: 'My personal information, shown without my consent',
  other: 'Something else',
};

export const REPORT_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const moderationItemsQuery = z.object({
  status: z.enum(MODERATION_STATUSES).default('pending'),
  orgId: z.uuid().optional(),
  /** Cursor: the `next` value from the previous page. */
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const reportsQuery = z.object({
  status: z.enum(REPORT_STATUSES).default('open'),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Clearing: an optional note for the record. */
export const moderationClearInput = z.object({ note: optionalText(1000).optional() });
export type ModerationClearInput = z.input<typeof moderationClearInput>;

/** Every action against an org's content: the reason is emailed to its owners. */
export const moderationReasonInput = z.object({ reason: text(1000) });
export type ModerationReasonInput = z.input<typeof moderationReasonInput>;

export const revokeOrgCredentialsInput = z.object({
  /** For the record and the owners' email. */
  reason: text(1000),
  /** Shown on each badge's page. */
  publicReason: optionalText(500).optional(),
});
export type RevokeOrgCredentialsInput = z.input<typeof revokeOrgCredentialsInput>;

export const trustOrgInput = z.object({ trusted: z.boolean() });
export type TrustOrgInput = z.input<typeof trustOrgInput>;

export const disableUserInput = z.object({
  reason: text(1000),
  /** The org whose content led to it: the event goes in its audit log and its owners are told. */
  orgId: z.uuid().optional(),
});
export type DisableUserInput = z.input<typeof disableUserInput>;

export const resolveReportInput = z.object({
  status: z.enum(['resolved', 'dismissed'], { error: 'Choose resolved or dismissed' }),
  note: optionalText(1000).optional(),
});
export type ResolveReportInput = z.input<typeof resolveReportInput>;

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

/** What the award email would say (the award form's preview); signs nothing. */
export const awardPreviewInput = z.object({
  achievementId: z.uuid('Choose an achievement'),
  recipient: z.object({ name: z.string().trim().max(200).optional() }).optional(),
});

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

/** The query of `POST …/batches` with a CSV file as the raw body: the achievement and file name. */
export const batchCsvQuery = z.object({
  achievementId: z.uuid('Choose an achievement'),
  fileName: z.string().trim().max(200).optional(),
});

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

// ---- API keys (design plan §10, §12) ----

export const createApiKeyInput = z.object({
  /** What the key is for, e.g. "LMS integration". */
  name: text(100),
  scopes: z
    .array(z.enum(API_KEY_SCOPES, { error: 'Choose what the key may do' }))
    .min(1, 'Choose at least one permission')
    .transform((scopes) => [...new Set(scopes)]),
  /** Days until the key stops working; null or left out for no expiry. */
  expiresInDays: z
    .number({ error: 'Enter a number of days' })
    .int('Enter a whole number of days')
    .min(1, 'At least 1 day')
    .max(730, 'At most 2 years')
    .nullable()
    .optional(),
});
export type CreateApiKeyInput = z.input<typeof createApiKeyInput>;

export const auditEventsQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---- recipients: My badges (design plan §8.8) ----

export const recipientCredentialsQuery = z.object({
  /** Cursor: the `next` value from the previous page. */
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** The recipient hides their badge's public page, or makes it public again. */
export const updateRecipientCredentialInput = z.object({
  visibility: z.enum(['public', 'hidden'], { error: 'Choose public or hidden' }),
});
export type UpdateRecipientCredentialInput = z.input<typeof updateRecipientCredentialInput>;

/** More addresses one person receives badges at, besides the account's own (decision 52). */
export const MAX_EXTRA_EMAILS = 5;

export const addEmailInput = z.object({ email: emailField });
export type AddEmailInput = z.input<typeof addEmailInput>;

/** The token from the confirmation link emailed to the address. */
export const confirmEmailInput = z.object({ token: z.string().trim().min(1).max(200) });
export type ConfirmEmailInput = z.input<typeof confirmEmailInput>;

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

/** Whether the issuer has proven it controls its website's domain (design plan §6.3). */
export interface DomainStatus {
  /** The website's host, e.g. `example.org`. */
  host: string;
  /** When it was verified; null while the website is self-reported. */
  verifiedAt: string | null;
  method: 'dns' | 'file' | null;
}

/** Where an issuer's or achievement's public content stands with review (design plan §6.5). */
export interface ContentReview {
  /** Its current public text. Public pages show the last cleared text while this waits. */
  text: ModerationStatus;
  /** Its current image (badge image or logo); null when there is none. */
  image: ModerationStatus | null;
}

export interface Issuer {
  id: string;
  /** The permanent issuer id embedded in credentials: `{PUBLIC_BASE_URL}/issuers/{id}`. */
  url: string;
  name: string;
  website: string | null;
  /** Null when there is no website. */
  domain: DomainStatus | null;
  email: string | null;
  description: string | null;
  logo: ImageSet | null;
  review: ContentReview;
  keys: SigningKeySummary[];
  createdAt: string;
  updatedAt: string;
}

/**
 * How to prove control of the website's domain: publish `value` in a DNS TXT record at
 * `dnsName`, or serve it as the whole content of `fileUrl`. Either one is enough.
 */
export interface DomainVerification extends DomainStatus {
  value: string;
  dnsName: string;
  fileUrl: string;
  /** The last check, if there was one. */
  lastCheckedAt: string | null;
}

/** The result of checking now. */
export interface DomainCheckResult {
  verified: boolean;
  /** What was found where, for each method, in plain words. */
  findings: { method: 'dns' | 'file'; found: boolean; detail: string }[];
  domain: DomainVerification;
}

export interface ApiKey {
  id: string;
  name: string;
  /** The key's first part, `cf_{prefix}`, to recognize it; the rest is never shown again. */
  prefix: string;
  scopes: ApiKeyScope[];
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** A new key: `key` is shown only in this response. */
export interface CreatedApiKey extends ApiKey {
  key: string;
}

export interface PlatformOrg extends OrgSummary {
  approvedAt: string | null;
  requestedBy: { id: string; name: string; email: string; disabled: boolean } | null;
  /** When a platform admin marked it trusted: its content skips review (design plan §6.5). */
  trustedAt: string | null;
  /** Its content waiting for review, and open reports about its pages. */
  review: { pending: number; openReports: number };
  /** Badges it awarded that aren't revoked. */
  activeCredentials: number;
  memberCount: number;
  issuers: { id: string; name: string; website: string | null; domainVerified: boolean }[];
  /** This org's own limit; null uses the instance default. */
  dailySendLimit: number | null;
  /** The instance default (DEFAULT_ORG_DAILY_SEND_LIMIT); 0 means no limit. */
  defaultDailySendLimit: number;
  /** Uploads per hour and stored MB: its own (null: the default) and the defaults (0: none). */
  uploadRateLimit: number | null;
  defaultUploadRateLimit: number;
  storageQuotaMb: number | null;
  defaultStorageQuotaMb: number;
  storageUsedBytes: number;
}

/** A category a scanner scored, from 0 to 1, in the provider's own words. */
export interface CategoryScore {
  category: string;
  score: number;
}

/** Why a moderation item is (or was) held. */
export interface ModerationFlag {
  source: 'review' | 'blocklist' | 'report' | 'scan' | 'hash_match';
  at: string;
  /** Word-list terms found (`blocklist`), as the operator listed them. */
  terms: string[] | null;
  /** The report (`report`). */
  reportId: string | null;
  category: ReportCategory | null;
  /** The scanner (`scan`) or known-CSAM matcher (`hash_match`). */
  provider: string | null;
  /** Categories at or over the operator's hold threshold, highest first (`scan`). */
  scores: CategoryScore[] | null;
}

/** The automatic check of an item (design plan §6.5, decision 60). */
export interface ModerationScan {
  /** `waiting` to run (nothing is published meanwhile), `done`, or `failed` (a person decides). */
  status: 'waiting' | 'done' | 'failed';
  scannedAt: string | null;
  /** The classifier, and every category it scored, highest first. */
  provider: string | null;
  scores: CategoryScore[];
  /** Checked against lists of known child sexual abuse material, with no match. */
  hashChecked: boolean;
  /** Why the last attempt failed. */
  error: string | null;
}

export interface ModerationUser {
  id: string;
  name: string;
  email: string;
  /** Disabled by a platform admin. */
  disabled: boolean;
}

/** One version of an org's public content in the moderation queue (design plan §6.5). */
export interface ModerationItem {
  id: string;
  kind: 'image' | 'text';
  status: ModerationStatus;
  flags: ModerationFlag[];
  org: { id: string; name: string; status: OrgStatus; trusted: boolean };
  subject: {
    type: 'organization' | 'issuer' | 'achievement';
    id: string;
    name: string;
    /** Its public page; null for an org or a draft. */
    pageUrl: string | null;
    /** An achievement a platform admin unpublished. */
    removed: boolean;
  };
  /** Text items: each field as submitted. */
  text: { field: string; label: string; value: string }[] | null;
  /** Image items: fetch the image itself, blurred or not, from `…/items/{id}/image`. */
  image: { mimeType: string; width: number | null; height: number | null } | null;
  /** Null when no automatic check applied. */
  scan: ModerationScan | null;
  /**
   * The image is never shown, not even blurred: `known_csam` after a match (for good), or
   * `awaiting_check` until the known-CSAM check has passed.
   */
  withheld: 'known_csam' | 'awaiting_check' | null;
  /** The sealed evidence of a known-CSAM match (`cli.js export-evidence`). */
  evidenceId: string | null;
  /** Badges awarded to the org's members that carry it and wait for it. */
  heldCredentials: number;
  submittedBy: ModerationUser | null;
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: { name: string; email: string } | null;
  decisionNote: string | null;
}

export interface ModerationItemPage {
  items: ModerationItem[];
  next: string | null;
}

/** A report from a public page's "Report a problem" form. */
export interface ContentReport {
  id: string;
  status: ReportStatus;
  category: ReportCategory;
  details: string | null;
  /** Given by the reporter for a reply, if they chose to. */
  reporterEmail: string | null;
  createdAt: string;
  target: {
    type: 'credential' | 'achievement' | 'issuer';
    id: string;
    pageUrl: string;
    name: string;
  };
  org: { id: string; name: string; status: OrgStatus; trusted: boolean };
  /** The content the reported page shows (or showed), to review with it. */
  items: ModerationItem[];
  /** Images a child-safety report held at once. */
  heldItemIds: string[];
  resolvedAt: string | null;
  resolvedBy: { name: string; email: string } | null;
  resolutionNote: string | null;
}

export interface ContentReportPage {
  reports: ContentReport[];
  next: string | null;
}

export interface ModerationSummary {
  pendingItems: number;
  openReports: number;
  /** The automatic checks set up on this instance (design plan §6.5). */
  scanning: {
    /** The classifier, and what it checks; null when none is set up. */
    provider: string | null;
    images: boolean;
    text: boolean;
    /** The known-CSAM matcher; null when none is set up. */
    csamMatcher: string | null;
    /** Items waiting for their check, and checks that gave up (waiting for a person). */
    waiting: number;
    failed: number;
  };
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
  review: ContentReview;
  /** Unpublished by a platform admin (design plan §6.5): archived until one puts it back. */
  removed: { at: string; reason: string | null } | null;
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
  /** Null once the recipient's data was erased. */
  to: string | null;
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
  /** Null once the recipient's data was erased. */
  recipient: { name: string; email: string } | null;
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
  /** When the recipient's data was erased (design plan §12.1): the badge is a revoked tombstone. */
  erasedAt: string | null;
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
  /** The signed OB 3.0 credential; null once the recipient's data was erased. */
  document: Record<string, unknown> | null;
  /** Who erased the recipient's data, from the audit log. */
  erasedBy: { label: string | null } | null;
}

/**
 * What erasing a badge's recipient covers (design plan §12.1): every badge the org awarded to the
 * same address, the badges linked to those by a reissue, and the CSV rows holding the address.
 */
export interface RecipientErasurePreview {
  /** As the org knows them; null when this badge's recipient was already erased. */
  recipient: { name: string; email: string } | null;
  credentials: {
    id: string;
    achievement: { id: string; name: string };
    state: CredentialState;
    validFrom: string;
    /** Already erased (a badge erased earlier, linked by a reissue). */
    erased: boolean;
  }[];
  /** Badges the erasure will revoke; the others are revoked already. */
  toRevoke: number;
  /** CSV batch rows holding the address. */
  batchRows: number;
}

export interface RecipientErasureResult {
  /** Also in the audit log's `credential.erased` events. */
  erasureId: string;
  /** The badges erased now. */
  erased: string[];
  /** Those of them that were still valid and are now revoked. */
  revoked: string[];
  batchRows: number;
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
  /** When the person on this row had their data erased; `values` is then null. */
  erasedAt: string | null;
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

/** What a recipient (and anyone else) may know about a revocation: never the internal reason. */
export interface PublicRevocation {
  /** `superseded` when a corrected copy replaced it. */
  kind: 'revoked' | 'superseded';
  at: string;
  /** The reason the issuer chose to show publicly, if any. */
  publicReason: string | null;
}

/**
 * One of the signed-in person's badges in My badges (design plan §8.8): a credential awarded to
 * one of their confirmed addresses, by any organization. What it says comes from the signed
 * credential, as on its public page.
 */
export interface RecipientCredential {
  id: string;
  /** The badge's permanent public page. */
  url: string;
  achievement: {
    id: string;
    url: string;
    name: string;
    description: string;
    /** The 512 px badge image it was awarded with. */
    image: string | null;
  };
  issuer: { id: string; url: string; name: string; logo: string | null };
  /** The name and address it was awarded to. */
  recipient: { name: string; email: string };
  /** From the status and the dates: valid, not valid yet, expired or revoked. */
  state: CredentialState;
  validFrom: string;
  validUntil: string | null;
  revocation: PublicRevocation | null;
  /** `hidden`: its page answers "not found" to everyone but its recipient. */
  visibility: 'public' | 'hidden';
  downloads: { png: string; svg: string | null; json: string; certificate: string };
  /** LinkedIn's "Add license or certification" form, filled in. */
  linkedInUrl: string;
  createdAt: string;
}

export interface RecipientCredentialPage {
  credentials: RecipientCredential[];
  /** Pass as `before` for the next (older) page; null on the last page. */
  next: string | null;
  /** The confirmed addresses matched: the account's own, then its confirmed extra addresses. */
  addresses: string[];
}

/** An extra address on the account (decision 52). It is never a way to sign in. */
export interface AccountEmail {
  id: string;
  email: string;
  /** When it was confirmed; null while its confirmation link hasn't been opened. */
  verifiedAt: string | null;
  /** When the latest confirmation link was sent. */
  sentAt: string | null;
  createdAt: string;
}
