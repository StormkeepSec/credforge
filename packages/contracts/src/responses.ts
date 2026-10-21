/**
 * Zod schemas of the API's responses, for the OpenAPI document (`GET /api/v1/openapi.json`). The
 * response types in `api.ts` stay the source the code uses; each schema here is checked against
 * its type at compile time (the `Same` assertions at the end), so the two can't drift apart.
 */
import { z } from 'zod';
import type {
  AccountEmail,
  Achievement,
  AchievementRevision,
  ApiKey,
  AuditEventPage,
  AwardPreview,
  BatchDetails,
  BatchPage,
  BatchRowPage,
  BulkRevokeResult,
  ContentReport,
  ContentReportPage,
  CreatedApiKey,
  CredentialDetails,
  CredentialPage,
  DomainCheckResult,
  DomainVerification,
  InstanceInfo,
  Invitation,
  InvitationPreview,
  Issuer,
  Member,
  MeResponse,
  ModerationItem,
  ModerationItemPage,
  ModerationSummary,
  OrgDetails,
  PlatformOrg,
  Problem,
  RecipientCredential,
  RecipientCredentialPage,
  RecipientErasurePreview,
  RecipientErasureResult,
  VerifyResult,
} from './api';
import {
  MODERATION_STATUSES,
  ORG_STATUSES,
  REPORT_CATEGORIES,
  REPORT_STATUSES,
  SIGNUP_MODES,
} from './api';
import { API_KEY_SCOPES, ORG_ROLES, PERMISSIONS } from './roles';

const dateTime = z.string().describe('ISO 8601 date-time');
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable();
const role = z.enum(ORG_ROLES);
const orgStatus = z.enum(ORG_STATUSES);
const moderationStatus = z.enum(MODERATION_STATUSES);

/** Where an issuer's or achievement's public content stands with review. */
const contentReviewSchema = z
  .object({
    text: moderationStatus.describe('Public pages show the last cleared text while this waits'),
    image: nullable(moderationStatus),
  })
  .meta({ id: 'ContentReview' });

export const problemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    code: z.string().describe('Machine-readable reason, e.g. `validation_failed`'),
    errors: z
      .record(z.string(), z.string())
      .optional()
      .describe('Field errors for `validation_failed`: dotted path → message'),
  })
  .meta({ id: 'Problem', description: 'An RFC 9457 problem (`application/problem+json`).' });

export const instanceInfoSchema = z
  .object({
    signupMode: z.enum(SIGNUP_MODES),
    providers: z.object({ google: z.boolean(), microsoft: z.boolean() }),
    requireMfaForAdmins: z.boolean(),
  })
  .meta({ id: 'InstanceInfo' });

const orgSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: orgStatus,
  statusReason: nullable(z.string()),
  createdAt: dateTime,
});

const invitationForRecipientSchema = z.object({
  id: z.uuid(),
  org: z.object({ id: z.uuid(), name: z.string() }),
  role,
  invitedByName: nullable(z.string()),
  expiresAt: dateTime,
});

export const meResponseSchema = z
  .object({
    user: z.object({
      id: z.uuid(),
      name: z.string(),
      email: z.string(),
      emailVerified: z.boolean(),
      image: nullable(z.string()),
      isPlatformAdmin: z.boolean(),
      twoFactorEnabled: z.boolean(),
    }),
    mfa: z.object({ state: z.enum(['ok', 'challenge', 'setup']), required: z.boolean() }),
    signInMethods: z.array(z.object({ id: z.string(), provider: z.string() })),
    memberships: z.array(z.object({ org: orgSummarySchema, role })),
    invitations: z.array(invitationForRecipientSchema),
  })
  .meta({ id: 'Me' });

export const orgDetailsSchema = orgSummarySchema
  .extend({
    role,
    permissions: z.array(z.enum(PERMISSIONS)),
    approvedAt: nullable(dateTime),
    dailySendLimit: nullable(z.number().int()),
  })
  .meta({ id: 'Organization' });

export const memberSchema = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    name: z.string(),
    email: z.string(),
    role,
    twoFactorEnabled: z.boolean(),
    createdAt: dateTime,
  })
  .meta({ id: 'Member' });

export const invitationSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    role,
    invitedBy: nullable(z.object({ id: z.string(), name: z.string() })),
    expiresAt: dateTime,
    createdAt: dateTime,
  })
  .meta({ id: 'Invitation' });

export const invitationPreviewSchema = invitationForRecipientSchema
  .extend({ email: z.string() })
  .meta({ id: 'InvitationPreview' });

const imageSetSchema = z
  .object({
    url: z.string().describe('The cleaned original (PNG or SVG), as in credentials'),
    url512: z.string(),
    url128: z.string(),
    ogUrl: nullable(z.string()),
    mimeType: z.enum(['image/png', 'image/svg+xml']),
    width: nullable(z.number().int()),
    height: nullable(z.number().int()),
  })
  .meta({ id: 'ImageSet', description: 'Permanent, content-addressed image URLs.' });

const domainStatusSchema = z.object({
  host: z.string(),
  verifiedAt: nullable(dateTime),
  method: nullable(z.enum(['dns', 'file'])),
});

export const issuerSchema = z
  .object({
    id: z.uuid(),
    url: z.string().describe('The permanent issuer id embedded in credentials'),
    name: z.string(),
    website: nullable(z.string()),
    domain: nullable(domainStatusSchema),
    email: nullable(z.string()),
    description: nullable(z.string()),
    logo: nullable(imageSetSchema),
    review: contentReviewSchema,
    keys: z.array(
      z.object({
        id: z.uuid(),
        algorithm: z.literal('Ed25519'),
        publicKeyMultibase: z.string(),
        status: z.enum(['active', 'retired', 'revoked']),
        createdAt: dateTime,
      }),
    ),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: 'Issuer' });

export const domainVerificationSchema = domainStatusSchema
  .extend({
    value: z.string().describe('Publish this in DNS or as the whole file'),
    dnsName: z.string().describe('Where the TXT record goes'),
    fileUrl: z.string().describe('Where the file goes'),
    lastCheckedAt: nullable(dateTime),
  })
  .meta({ id: 'DomainVerification' });

export const domainCheckResultSchema = z
  .object({
    verified: z.boolean(),
    findings: z.array(
      z.object({ method: z.enum(['dns', 'file']), found: z.boolean(), detail: z.string() }),
    ),
    domain: domainVerificationSchema,
  })
  .meta({ id: 'DomainCheckResult' });

export const platformOrgSchema = orgSummarySchema
  .extend({
    approvedAt: nullable(dateTime),
    requestedBy: nullable(
      z.object({ id: z.uuid(), name: z.string(), email: z.string(), disabled: z.boolean() }),
    ),
    trustedAt: nullable(dateTime).describe('Trusted orgs’ content skips review'),
    review: z.object({ pending: z.number().int(), openReports: z.number().int() }),
    activeCredentials: z.number().int(),
    memberCount: z.number().int(),
    issuers: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        website: nullable(z.string()),
        domainVerified: z.boolean(),
      }),
    ),
    dailySendLimit: nullable(z.number().int()),
    defaultDailySendLimit: z.number().int(),
    uploadRateLimit: nullable(z.number().int()),
    defaultUploadRateLimit: z.number().int(),
    storageQuotaMb: nullable(z.number().int()),
    defaultStorageQuotaMb: z.number().int(),
    storageUsedBytes: z.number().int(),
  })
  .meta({ id: 'PlatformOrg' });

const moderationUserSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  disabled: z.boolean(),
});
const moderationOrgSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: orgStatus,
  trusted: z.boolean(),
});
const decidedBySchema = nullable(z.object({ name: z.string(), email: z.string() }));
const categoryScoreSchema = z.object({ category: z.string(), score: z.number().min(0).max(1) });

export const moderationItemSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['image', 'text']),
    status: moderationStatus,
    flags: z.array(
      z.object({
        source: z.enum(['review', 'blocklist', 'report', 'scan', 'hash_match']),
        at: dateTime,
        terms: nullable(z.array(z.string())),
        reportId: nullable(z.uuid()),
        category: nullable(z.enum(REPORT_CATEGORIES)),
        provider: nullable(z.string()),
        scores: nullable(z.array(categoryScoreSchema)),
      }),
    ),
    org: moderationOrgSchema,
    subject: z.object({
      type: z.enum(['organization', 'issuer', 'achievement']),
      id: z.uuid(),
      name: z.string(),
      pageUrl: nullable(z.string()),
      removed: z.boolean(),
    }),
    text: nullable(z.array(z.object({ field: z.string(), label: z.string(), value: z.string() }))),
    image: nullable(
      z.object({
        mimeType: z.string(),
        width: nullable(z.number().int()),
        height: nullable(z.number().int()),
      }),
    ),
    scan: nullable(
      z.object({
        status: z.enum(['waiting', 'done', 'failed']),
        scannedAt: nullable(dateTime),
        provider: nullable(z.string()),
        scores: z.array(categoryScoreSchema),
        hashChecked: z.boolean(),
        error: nullable(z.string()),
      }),
    ),
    withheld: nullable(z.enum(['known_csam', 'awaiting_check'])),
    evidenceId: nullable(z.uuid()),
    heldCredentials: z.number().int(),
    submittedBy: nullable(moderationUserSchema),
    submittedAt: dateTime,
    decidedAt: nullable(dateTime),
    decidedBy: decidedBySchema,
    decisionNote: nullable(z.string()),
  })
  .meta({ id: 'ModerationItem' });

export const moderationItemPageSchema = z
  .object({ items: z.array(moderationItemSchema), next: nullable(z.string()) })
  .meta({ id: 'ModerationItemPage' });

export const contentReportSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(REPORT_STATUSES),
    category: z.enum(REPORT_CATEGORIES),
    details: nullable(z.string()),
    reporterEmail: nullable(z.string()),
    createdAt: dateTime,
    target: z.object({
      type: z.enum(['credential', 'achievement', 'issuer']),
      id: z.uuid(),
      pageUrl: z.string(),
      name: z.string(),
    }),
    org: moderationOrgSchema,
    items: z.array(moderationItemSchema),
    heldItemIds: z.array(z.uuid()),
    resolvedAt: nullable(dateTime),
    resolvedBy: decidedBySchema,
    resolutionNote: nullable(z.string()),
  })
  .meta({ id: 'ContentReport' });

export const contentReportPageSchema = z
  .object({ reports: z.array(contentReportSchema), next: nullable(z.string()) })
  .meta({ id: 'ContentReportPage' });

export const moderationSummarySchema = z
  .object({
    pendingItems: z.number().int(),
    openReports: z.number().int(),
    scanning: z.object({
      provider: nullable(z.string()),
      images: z.boolean(),
      text: z.boolean(),
      csamMatcher: nullable(z.string()),
      waiting: z.number().int(),
      failed: z.number().int(),
    }),
  })
  .meta({ id: 'ModerationSummary' });

const alignmentSchema = z.object({
  targetName: z.string(),
  targetUrl: z.string(),
  targetDescription: nullable(z.string()),
  targetFramework: nullable(z.string()),
  targetCode: nullable(z.string()),
  targetType: nullable(z.string()),
});

export const achievementSchema = z
  .object({
    id: z.uuid(),
    url: z.string().describe('The permanent id embedded in credentials'),
    issuerId: z.uuid(),
    name: z.string(),
    description: z.string(),
    criteriaNarrative: nullable(z.string()),
    criteriaUrl: nullable(z.string()),
    achievementType: z.string(),
    tags: z.array(z.string()),
    alignments: z.array(alignmentSchema),
    validForDays: nullable(z.number().int()),
    image: nullable(imageSetSchema),
    review: contentReviewSchema,
    removed: nullable(z.object({ at: dateTime, reason: nullable(z.string()) })).describe(
      'Unpublished by a platform admin: archived until one puts it back',
    ),
    revision: z.number().int(),
    status: z.enum(['draft', 'active', 'archived']),
    awardedCount: z.number().int(),
    publishedAt: nullable(dateTime),
    archivedAt: nullable(dateTime),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: 'Achievement' });

export const achievementRevisionSchema = z
  .object({
    revision: z.number().int(),
    createdAt: dateTime,
    createdBy: nullable(z.object({ id: z.string(), name: z.string() })),
  })
  .meta({ id: 'AchievementRevision' });

const deliveryStatus = z.enum([
  'not_sent',
  'queued',
  'sent',
  'delivered',
  'bounced',
  'dropped',
  'spam_reported',
  'failed',
]);

const emailDeliverySchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  to: nullable(z.string()).describe('Null once the recipient’s data was erased'),
  status: deliveryStatus.exclude(['not_sent']),
  attempts: z.number().int(),
  lastError: nullable(z.string()),
  events: z.array(z.object({ event: z.string(), at: dateTime, reason: z.string().optional() })),
  createdAt: dateTime,
  sentAt: nullable(dateTime),
  deliveredAt: nullable(dateTime),
  bouncedAt: nullable(dateTime),
});

const credentialSummaryShape = {
  id: z.uuid(),
  url: z.string().describe('The credential’s permanent public URL'),
  achievement: z.object({
    id: z.uuid(),
    name: z.string(),
    revision: z.number().int(),
    image128: nullable(z.string()),
  }),
  recipient: nullable(z.object({ name: z.string(), email: z.string() })).describe(
    'Null once the recipient’s data was erased',
  ),
  status: z.enum(['draft', 'issued', 'revoked']),
  state: z.enum(['valid', 'not_yet_valid', 'expired', 'revoked']),
  validFrom: dateTime,
  validUntil: nullable(dateTime),
  visibility: z.enum(['public', 'hidden']),
  acceptedAt: nullable(dateTime),
  delivery: deliveryStatus,
  revocation: nullable(
    z.object({
      kind: z.enum(['revoked', 'superseded']),
      at: dateTime,
      reason: nullable(z.string()),
      publicReason: nullable(z.string()),
    }),
  ),
  batchId: nullable(z.uuid()),
  replacedById: nullable(z.uuid()),
  replacesId: nullable(z.uuid()),
  erasedAt: nullable(dateTime).describe(
    'When the recipient’s data was erased: the badge is a revoked tombstone',
  ),
  createdAt: dateTime,
};

const credentialSummarySchema = z.object(credentialSummaryShape).meta({ id: 'CredentialSummary' });

export const credentialDetailsSchema = z
  .object({
    ...credentialSummaryShape,
    issuedBy: z.object({
      type: z.enum(['user', 'api_key']),
      id: nullable(z.string()),
      label: nullable(z.string()),
    }),
    claimLinkExpiresAt: nullable(dateTime),
    emails: z.array(emailDeliverySchema),
    customFields: z.record(z.string(), z.string()),
    evidence: z.array(
      z.object({
        url: nullable(z.string()),
        name: nullable(z.string()),
        narrative: nullable(z.string()),
      }),
    ),
    revokedBy: nullable(z.object({ label: nullable(z.string()) })),
    document: nullable(z.record(z.string(), z.unknown())).describe(
      'The signed Open Badges 3.0 credential (OpenBadgeCredential); null once the recipient’s data was erased',
    ),
    erasedBy: nullable(z.object({ label: nullable(z.string()) })),
  })
  .meta({ id: 'Credential' });

const credentialStateSchema = z.enum(['valid', 'not_yet_valid', 'expired', 'revoked']);

export const recipientErasurePreviewSchema = z
  .object({
    recipient: nullable(z.object({ name: z.string(), email: z.string() })),
    credentials: z.array(
      z.object({
        id: z.uuid(),
        achievement: z.object({ id: z.uuid(), name: z.string() }),
        state: credentialStateSchema,
        validFrom: dateTime,
        erased: z.boolean(),
      }),
    ),
    toRevoke: z.number().int(),
    batchRows: z.number().int(),
  })
  .meta({ id: 'RecipientErasurePreview' });

export const recipientErasureResultSchema = z
  .object({
    erasureId: z.uuid(),
    erased: z.array(z.uuid()),
    revoked: z.array(z.uuid()),
    batchRows: z.number().int(),
  })
  .meta({ id: 'RecipientErasureResult' });

export const credentialPageSchema = z
  .object({
    credentials: z.array(credentialSummarySchema),
    next: nullable(z.string()).describe('Pass as `before` for the next page; null on the last'),
  })
  .meta({ id: 'CredentialPage' });

export const awardPreviewSchema = z
  .object({
    email: z.object({
      subject: z.string(),
      text: z.string(),
      from: z.string(),
      replyTo: nullable(z.string()),
    }),
  })
  .meta({ id: 'AwardPreview' });

export const bulkRevokeResultSchema = z
  .object({
    revoked: z.array(z.uuid()),
    alreadyRevoked: z.array(z.uuid()),
    notFound: z.array(z.uuid()),
  })
  .meta({ id: 'BulkRevokeResult' });

const actorRef = z.object({
  type: z.enum(['user', 'api_key']),
  id: nullable(z.string()),
  label: nullable(z.string()),
});

const batchSummaryShape = {
  id: z.uuid(),
  achievement: z.object({ id: z.uuid(), name: z.string() }),
  source: z.enum(['csv', 'api']),
  fileName: nullable(z.string()),
  status: z.enum(['draft', 'queued', 'running', 'completed', 'failed']),
  totalRows: z.number().int(),
  counts: z.object({
    ready: z.number().int(),
    invalid: z.number().int(),
    duplicate: z.number().int(),
    existing: z.number().int(),
    pending: z.number().int(),
    issued: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
  }),
  options: z.object({ sendEmail: z.boolean(), awardExisting: z.boolean() }),
  createdBy: actorRef,
  error: nullable(z.string()),
  createdAt: dateTime,
  confirmedAt: nullable(dateTime),
  startedAt: nullable(dateTime),
  finishedAt: nullable(dateTime),
};

export const batchPageSchema = z
  .object({
    batches: z.array(z.object(batchSummaryShape).meta({ id: 'BatchSummary' })),
    next: nullable(z.string()),
  })
  .meta({ id: 'BatchPage' });

export const batchDetailsSchema = z
  .object({
    ...batchSummaryShape,
    hasHeader: z.boolean(),
    columns: z.array(
      z.object({
        header: z.string(),
        target: z.enum([
          'name',
          'firstName',
          'lastName',
          'email',
          'issuedOn',
          'expiresOn',
          'evidenceUrl',
          'custom',
          'ignore',
        ]),
        samples: z.array(z.string()),
      }),
    ),
    plan: z.object({
      toAward: z.number().int(),
      toSkip: z.number().int(),
      emails: z.number().int(),
      sendLimit: z.object({
        limit: nullable(z.number().int()),
        remaining: nullable(z.number().int()),
      }),
    }),
  })
  .meta({ id: 'Batch' });

export const batchRowPageSchema = z
  .object({
    rows: z.array(
      z.object({
        rowNumber: z.number().int(),
        values: nullable(
          z.object({
            name: z.string(),
            email: z.string(),
            issuedOn: z.string().optional(),
            expiresOn: z.string().optional(),
            evidenceUrl: z.string().optional(),
            custom: z.record(z.string(), z.string()),
          }),
        ),
        validation: z.enum(['ready', 'invalid', 'duplicate', 'existing']),
        issues: z.array(z.object({ field: z.string(), message: z.string() })),
        status: z.enum(['draft', 'pending', 'issued', 'failed', 'skipped']),
        credential: nullable(z.object({ id: z.uuid(), url: z.string() })),
        error: nullable(z.object({ code: z.string(), message: z.string() })),
        erasedAt: nullable(dateTime),
      }),
    ),
    next: nullable(z.number().int()),
  })
  .meta({ id: 'BatchRowPage' });

const verifyCheckSchema = z.object({
  outcome: z.enum(['passed', 'failed', 'skipped']),
  message: z.string(),
  details: z.array(z.string()).optional(),
});

export const verifyResultSchema = z
  .object({
    verified: z.boolean(),
    checkedAt: dateTime,
    source: z.enum(['url', 'json', 'png', 'svg']),
    credential: nullable(
      z.object({
        id: nullable(z.string()),
        name: nullable(z.string()),
        achievement: z.object({
          id: nullable(z.string()),
          name: nullable(z.string()),
          description: nullable(z.string()),
        }),
        issuer: z.object({
          id: nullable(z.string()),
          name: nullable(z.string()),
          url: nullable(z.string()),
        }),
        recipientName: nullable(z.string()),
        validFrom: nullable(z.string()),
        validUntil: nullable(z.string()),
        issuedHere: z.boolean(),
      }),
    ),
    checks: z.object({
      format: verifyCheckSchema,
      proof: verifyCheckSchema,
      status: verifyCheckSchema,
      validity: verifyCheckSchema,
      recipient: verifyCheckSchema.optional(),
    }),
  })
  .meta({ id: 'VerifyResult' });

export const auditEventPageSchema = z
  .object({
    events: z.array(
      z.object({
        id: z.number().int(),
        action: z.string(),
        actor: z.object({
          type: z.enum(['user', 'system', 'api_key', 'recipient']),
          id: nullable(z.string()),
          label: nullable(z.string()),
        }),
        target: nullable(z.object({ type: z.string(), id: z.string() })),
        data: z.record(z.string(), z.unknown()),
        ip: nullable(z.string()),
        createdAt: dateTime,
      }),
    ),
    next: nullable(z.number().int()),
  })
  .meta({ id: 'AuditEventPage' });

const apiKeyShape = {
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.enum(API_KEY_SCOPES)),
  createdBy: nullable(z.object({ id: z.string(), name: z.string() })),
  createdAt: dateTime,
  expiresAt: nullable(dateTime),
  lastUsedAt: nullable(dateTime),
  revokedAt: nullable(dateTime),
};

export const apiKeySchema = z.object(apiKeyShape).meta({ id: 'ApiKey' });

export const createdApiKeySchema = z
  .object({ ...apiKeyShape, key: z.string().describe('The whole key. Shown only this once.') })
  .meta({ id: 'CreatedApiKey' });

export const recipientCredentialSchema = z
  .object({
    id: z.uuid(),
    url: z.string().describe('The badge’s permanent public page'),
    achievement: z.object({
      id: z.uuid(),
      url: z.string(),
      name: z.string(),
      description: z.string(),
      image: nullable(z.string()).describe('The 512 px badge image it was awarded with'),
    }),
    issuer: z.object({
      id: z.uuid(),
      url: z.string(),
      name: z.string(),
      logo: nullable(z.string()),
    }),
    recipient: z
      .object({ name: z.string(), email: z.string() })
      .describe('The name and address it was awarded to'),
    state: z.enum(['valid', 'not_yet_valid', 'expired', 'revoked']),
    validFrom: dateTime,
    validUntil: nullable(dateTime),
    revocation: nullable(
      z.object({
        kind: z.enum(['revoked', 'superseded']),
        at: dateTime,
        publicReason: nullable(z.string()),
      }),
    ).describe('Never the issuer’s internal reason'),
    visibility: z.enum(['public', 'hidden']),
    downloads: z.object({
      png: z.string(),
      svg: nullable(z.string()),
      json: z.string(),
      certificate: z.string(),
    }),
    linkedInUrl: z.string(),
    createdAt: dateTime,
  })
  .meta({ id: 'RecipientCredential' });

export const recipientCredentialPageSchema = z
  .object({
    credentials: z.array(recipientCredentialSchema),
    next: nullable(z.string()),
    addresses: z
      .array(z.string())
      .describe('The confirmed addresses matched: the account’s own, then its confirmed extras'),
  })
  .meta({ id: 'RecipientCredentialPage' });

export const accountEmailSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    verifiedAt: nullable(dateTime).describe('Null until its confirmation link is opened'),
    sentAt: nullable(dateTime),
    createdAt: dateTime,
  })
  .meta({ id: 'AccountEmail' });

// ---- compile-time checks: each schema describes exactly its response type ----

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Out<S extends z.ZodType> = z.output<S>;

const checks: {
  problem: Same<Omit<Out<typeof problemSchema>, 'code'>, Omit<Problem, 'code'>>;
  instance: Same<Out<typeof instanceInfoSchema>, InstanceInfo>;
  me: Same<Out<typeof meResponseSchema>, MeResponse>;
  org: Same<Out<typeof orgDetailsSchema>, OrgDetails>;
  member: Same<Out<typeof memberSchema>, Member>;
  invitation: Same<Out<typeof invitationSchema>, Invitation>;
  invitationPreview: Same<Out<typeof invitationPreviewSchema>, InvitationPreview>;
  issuer: Same<Out<typeof issuerSchema>, Issuer>;
  domainVerification: Same<Out<typeof domainVerificationSchema>, DomainVerification>;
  domainCheck: Same<Out<typeof domainCheckResultSchema>, DomainCheckResult>;
  platformOrg: Same<Out<typeof platformOrgSchema>, PlatformOrg>;
  moderationItem: Same<Out<typeof moderationItemSchema>, ModerationItem>;
  moderationItemPage: Same<Out<typeof moderationItemPageSchema>, ModerationItemPage>;
  contentReport: Same<Out<typeof contentReportSchema>, ContentReport>;
  contentReportPage: Same<Out<typeof contentReportPageSchema>, ContentReportPage>;
  moderationSummary: Same<Out<typeof moderationSummarySchema>, ModerationSummary>;
  achievement: Same<Out<typeof achievementSchema>, Achievement>;
  achievementRevision: Same<Out<typeof achievementRevisionSchema>, AchievementRevision>;
  credential: Same<Out<typeof credentialDetailsSchema>, CredentialDetails>;
  credentialPage: Same<Out<typeof credentialPageSchema>, CredentialPage>;
  erasurePreview: Same<Out<typeof recipientErasurePreviewSchema>, RecipientErasurePreview>;
  erasureResult: Same<Out<typeof recipientErasureResultSchema>, RecipientErasureResult>;
  awardPreview: Same<Out<typeof awardPreviewSchema>, AwardPreview>;
  bulkRevoke: Same<Out<typeof bulkRevokeResultSchema>, BulkRevokeResult>;
  batchPage: Same<Out<typeof batchPageSchema>, BatchPage>;
  batch: Same<Out<typeof batchDetailsSchema>, BatchDetails>;
  batchRows: Same<Out<typeof batchRowPageSchema>, BatchRowPage>;
  verify: Same<Out<typeof verifyResultSchema>, VerifyResult>;
  audit: Same<Out<typeof auditEventPageSchema>, AuditEventPage>;
  apiKey: Same<Out<typeof apiKeySchema>, ApiKey>;
  createdApiKey: Same<Out<typeof createdApiKeySchema>, CreatedApiKey>;
  recipientCredential: Same<Out<typeof recipientCredentialSchema>, RecipientCredential>;
  recipientPage: Same<Out<typeof recipientCredentialPageSchema>, RecipientCredentialPage>;
  accountEmail: Same<Out<typeof accountEmailSchema>, AccountEmail>;
} = {
  problem: true,
  instance: true,
  me: true,
  org: true,
  member: true,
  invitation: true,
  invitationPreview: true,
  issuer: true,
  domainVerification: true,
  domainCheck: true,
  platformOrg: true,
  moderationItem: true,
  moderationItemPage: true,
  contentReport: true,
  contentReportPage: true,
  moderationSummary: true,
  achievement: true,
  achievementRevision: true,
  credential: true,
  credentialPage: true,
  erasurePreview: true,
  erasureResult: true,
  awardPreview: true,
  bulkRevoke: true,
  batchPage: true,
  batch: true,
  batchRows: true,
  verify: true,
  audit: true,
  apiKey: true,
  createdApiKey: true,
  recipientCredential: true,
  recipientPage: true,
  accountEmail: true,
};
void checks;
