import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => timestamptz('created_at').notNull().defaultNow();
const updatedAt = () => timestamptz('updated_at').notNull().defaultNow();

/** Raw bytes (`bytea`), read and written as a Node Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** `column IN ('a', 'b')`, for text columns that hold one of a fixed set of values. */
function oneOf(column: { name: string }, values: readonly string[]) {
  return sql.raw(`"${column.name}" in (${values.map((value) => `'${value}'`).join(', ')})`);
}

/**
 * Instance-wide key/value settings.
 *
 * `public_base_url` is recorded on first start: every signed credential embeds URLs under it,
 * so the app refuses to start if it later changes (see apps/server/src/instance.ts).
 * `master_key_check` holds a value encrypted under CREDFORGE_MASTER_KEY, so a different key is
 * caught at startup instead of when an issuer first signs.
 */
export const instanceSettings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

// ---- Accounts (Better Auth: user, session, account, verification, two_factor) ----
// Column names follow the database's snake_case; Better Auth addresses fields by the property
// names below. Ids are UUIDs (`advanced.database.generateId: 'uuid'`).

export const user = pgTable('user', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** Always stored lowercase (Better Auth normalizes it). */
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  /** Instance operator: approves and suspends orgs. Set with `cli.js create-platform-admin`. */
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamptz('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /**
     * When this session passed a credforge second factor (TOTP or backup code). Null for a
     * session that hasn't, such as one started with Continue with Google (design plan §6.4).
     */
    mfaVerifiedAt: timestamptz('mfa_verified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('session_user_id_idx').on(table.userId)],
);

/**
 * Sign-in methods: `credential` (password) or a provider (`google`, `microsoft`).
 * Provider access, refresh and id tokens are stripped before a row is saved (§6.4), so those
 * columns stay null.
 */
export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamptz('access_token_expires_at'),
    refreshTokenExpiresAt: timestamptz('refresh_token_expires_at'),
    scope: text('scope'),
    /** Password hash, for the `credential` provider only. */
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('account_user_id_idx').on(table.userId),
    uniqueIndex('account_provider_account_idx').on(table.providerId, table.accountId),
  ],
);

/** Short-lived tokens: email verification, password reset, two-factor challenges. */
export const verification = pgTable(
  'verification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

/** TOTP secret and backup codes, both encrypted by Better Auth under AUTH_SECRET. */
export const twoFactor = pgTable('two_factor', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  verified: boolean('verified').notNull().default(true),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: timestamptz('locked_until'),
});

// ---- Organizations ----

export const ORG_STATUS_VALUES = ['pending', 'active', 'suspended', 'declined'] as const;
export const ORG_ROLE_VALUES = ['owner', 'admin', 'issuer', 'viewer'] as const;

/** The tenant and membership boundary. Every tenant-owned row carries `org_id`. */
export const organization = pgTable(
  'organization',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    status: text('status', { enum: ORG_STATUS_VALUES }).notNull().default('pending'),
    /** Shown to the org's members when it is declined or suspended. */
    statusReason: text('status_reason'),
    statusChangedAt: timestamptz('status_changed_at'),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    approvedBy: uuid('approved_by').references(() => user.id, { onDelete: 'set null' }),
    approvedAt: timestamptz('approved_at'),
    /**
     * Award emails this org may send in any 24 hours. Null uses the instance default
     * (DEFAULT_ORG_DAILY_SEND_LIMIT); 0 means no limit. Set by platform admins.
     */
    dailySendLimit: integer('daily_send_limit'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('organization_status_check', oneOf(table.status, ORG_STATUS_VALUES)),
    index('organization_status_idx').on(table.status, table.createdAt),
  ],
);

export const member = pgTable(
  'member',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ORG_ROLE_VALUES }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('member_org_user_idx').on(table.orgId, table.userId),
    index('member_user_id_idx').on(table.userId),
    check('member_role_check', oneOf(table.role, ORG_ROLE_VALUES)),
  ],
);

export const INVITATION_STATUS_VALUES = ['pending', 'accepted', 'revoked'] as const;

/**
 * An invitation to join an org. The link carries a 256-bit token; only its SHA-256 is stored.
 * "Expired" is computed from `expires_at`, never stored.
 */
export const invitation = pgTable(
  'invitation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    /** Normalized: trimmed and lowercase. */
    email: text('email').notNull(),
    role: text('role', { enum: ORG_ROLE_VALUES }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    status: text('status', { enum: INVITATION_STATUS_VALUES }).notNull().default('pending'),
    invitedBy: uuid('invited_by').references(() => user.id, { onDelete: 'set null' }),
    acceptedBy: uuid('accepted_by').references(() => user.id, { onDelete: 'set null' }),
    acceptedAt: timestamptz('accepted_at'),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One open invitation per address per org; inviting again refreshes it.
    uniqueIndex('invitation_org_email_pending_idx')
      .on(table.orgId, table.email)
      .where(sql`${table.status} = 'pending'`),
    index('invitation_email_idx').on(table.email),
    check('invitation_role_check', oneOf(table.role, ORG_ROLE_VALUES)),
    check('invitation_status_check', oneOf(table.status, INVITATION_STATUS_VALUES)),
  ],
);

// ---- Issuers ----

/** An OB `Profile`. Its id is public and permanent: `{PUBLIC_BASE_URL}/issuers/{id}`. */
export const issuer = pgTable(
  'issuer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    description: text('description'),
    /** The issuer's own website (self-reported until domain verification, M5). */
    url: text('url'),
    /** Public contact address. */
    email: text('email'),
    /** The logo (a `file` of kind `issuer_logo`), embedded in the profile and in credentials. */
    imageFileId: uuid('image_file_id').references((): AnyPgColumn => file.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('issuer_org_id_idx').on(table.orgId)],
);

export const SIGNING_KEY_STATUS_VALUES = ['active', 'retired', 'revoked'] as const;

/**
 * Issuer signing keys (design plan §6.2). The private key is AES-256-GCM encrypted under the
 * master key version `kek_version`; it never leaves the server and is never returned by the API.
 */
export const signingKey = pgTable(
  'signing_key',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    issuerId: uuid('issuer_id')
      .notNull()
      .references(() => issuer.id),
    algorithm: text('algorithm', { enum: ['Ed25519'] })
      .notNull()
      .default('Ed25519'),
    publicKeyMultibase: text('public_key_multibase').notNull().unique(),
    encryptedPrivateKey: text('encrypted_private_key').notNull(),
    kekVersion: integer('kek_version').notNull(),
    status: text('status', { enum: SIGNING_KEY_STATUS_VALUES }).notNull().default('active'),
    createdAt: createdAt(),
    retiredAt: timestamptz('retired_at'),
    revokedAt: timestamptz('revoked_at'),
  },
  (table) => [
    index('signing_key_issuer_id_idx').on(table.issuerId),
    uniqueIndex('signing_key_one_active_idx')
      .on(table.issuerId)
      .where(sql`${table.status} = 'active'`),
    check('signing_key_status_check', oneOf(table.status, SIGNING_KEY_STATUS_VALUES)),
    check('signing_key_algorithm_check', oneOf(table.algorithm, ['Ed25519'])),
  ],
);

// ---- Files ----

export const FILE_KIND_VALUES = ['issuer_logo', 'badge_image', 'csv_import', 'export'] as const;
export const FILE_VISIBILITY_VALUES = ['public', 'private'] as const;
export const STORAGE_DRIVER_VALUES = ['local', 's3'] as const;

/** A derived image stored next to the original, e.g. the 512 px PNG. */
export interface FileVariant {
  key: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
}

/**
 * Uploaded files (design plan §5.4, §13.5). Public images are content-addressed: their URLs
 * contain `sha256`, so the bytes behind a URL never change. A file an issued credential refers
 * to is marked `retain` and is never deleted.
 */
export const file = pgTable(
  'file',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    kind: text('kind', { enum: FILE_KIND_VALUES }).notNull(),
    /** The issuer (logo) or achievement (badge image) the file belongs to. */
    subjectId: uuid('subject_id'),
    driver: text('driver', { enum: STORAGE_DRIVER_VALUES }).notNull(),
    /** The bucket for `s3`; null for `local`. */
    bucket: text('bucket'),
    /** Object key of the original. */
    key: text('key').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    /** Hex SHA-256 of the stored (cleaned) original. */
    sha256: text('sha256').notNull(),
    width: integer('width'),
    height: integer('height'),
    /** Derived images by name (`512`, `128`, `og`). */
    variants: jsonb('variants').$type<Record<string, FileVariant>>().notNull().default({}),
    visibility: text('visibility', { enum: FILE_VISIBILITY_VALUES }).notNull(),
    /** Set once an issued credential refers to the file; such files are never deleted. */
    retain: boolean('retain').notNull().default(false),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [
    index('file_org_id_idx').on(table.orgId),
    uniqueIndex('file_subject_sha256_idx')
      .on(table.kind, table.subjectId, table.sha256)
      .where(sql`${table.subjectId} is not null`),
    check('file_kind_check', oneOf(table.kind, FILE_KIND_VALUES)),
    check('file_visibility_check', oneOf(table.visibility, FILE_VISIBILITY_VALUES)),
    check('file_driver_check', oneOf(table.driver, STORAGE_DRIVER_VALUES)),
  ],
);

// ---- Achievements ----

export const ACHIEVEMENT_STATUS_VALUES = ['draft', 'active', 'archived'] as const;

/** An OB 3.0 `Alignment`, as stored on an achievement. */
export interface AlignmentData {
  targetName: string;
  targetUrl: string;
  targetDescription?: string;
  targetFramework?: string;
  targetCode?: string;
  targetType?: string;
}

/** The fields of an achievement that are signed into credentials, as one revision holds them. */
export interface AchievementSnapshot {
  name: string;
  description: string;
  criteriaNarrative: string | null;
  criteriaUrl: string | null;
  achievementType: string;
  imageFileId: string | null;
  tags: string[];
  alignments: AlignmentData[];
  validForDays: number | null;
}

/**
 * What can be awarded (an OB `Achievement`). Its id is public and permanent:
 * `{PUBLIC_BASE_URL}/achievements/{id}`. The row holds the current revision; every saved change
 * adds an `achievement_revision`, and credentials record the revision they were issued with.
 * Drafts can't be awarded and aren't public.
 */
export const achievement = pgTable(
  'achievement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    issuerId: uuid('issuer_id')
      .notNull()
      .references(() => issuer.id),
    name: text('name').notNull(),
    description: text('description').notNull(),
    criteriaNarrative: text('criteria_narrative'),
    criteriaUrl: text('criteria_url'),
    /** An OB `AchievementType`, e.g. `Badge`, `Certificate`, `Course`. */
    achievementType: text('achievement_type').notNull().default('Badge'),
    imageFileId: uuid('image_file_id').references(() => file.id),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    alignments: jsonb('alignments').$type<AlignmentData[]>().notNull().default([]),
    /** Default validity of credentials awarded from it; null means they don't expire. */
    validForDays: integer('valid_for_days'),
    revision: integer('revision').notNull().default(1),
    status: text('status', { enum: ACHIEVEMENT_STATUS_VALUES }).notNull().default('draft'),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    publishedAt: timestamptz('published_at'),
    archivedAt: timestamptz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('achievement_org_idx').on(table.orgId, table.createdAt),
    index('achievement_issuer_idx').on(table.issuerId),
    check('achievement_status_check', oneOf(table.status, ACHIEVEMENT_STATUS_VALUES)),
  ],
);

/** Every saved version of an achievement's signed fields. */
export const achievementRevision = pgTable(
  'achievement_revision',
  {
    achievementId: uuid('achievement_id')
      .notNull()
      .references(() => achievement.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    data: jsonb('data').$type<AchievementSnapshot>().notNull(),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.achievementId, table.revision] })],
);

// ---- Status lists ----

export const STATUS_PURPOSE_VALUES = ['revocation', 'suspension'] as const;

/**
 * A W3C Bitstring Status List (design plan §7, §8.6), published signed at
 * `{PUBLIC_BASE_URL}/status/{issuerId}/{listNumber}`. `allocated` marks the indexes handed out
 * (chosen at random for herd privacy); `statuses` holds the published bits. `document` is the
 * signed BitstringStatusListCredential for `version`.
 */
export const statusList = pgTable(
  'status_list',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    issuerId: uuid('issuer_id')
      .notNull()
      .references(() => issuer.id),
    /** 1, 2, …: the list's number in its URL. */
    listNumber: integer('list_number').notNull(),
    purpose: text('purpose', { enum: STATUS_PURPOSE_VALUES }).notNull().default('revocation'),
    /** Number of entries (bits). */
    size: integer('size').notNull(),
    allocated: bytea('allocated').notNull(),
    allocatedCount: integer('allocated_count').notNull().default(0),
    statuses: bytea('statuses').notNull(),
    version: integer('version').notNull().default(1),
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    publishedAt: timestamptz('published_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('status_list_issuer_number_idx').on(table.issuerId, table.listNumber),
    check('status_list_purpose_check', oneOf(table.purpose, STATUS_PURPOSE_VALUES)),
  ],
);

// ---- Credentials ----

export const CREDENTIAL_STATUS_VALUES = ['draft', 'issued', 'revoked'] as const;
export const CREDENTIAL_VISIBILITY_VALUES = ['public', 'hidden'] as const;
export const ISSUED_BY_TYPES = ['user', 'api_key'] as const;

export interface EvidenceData {
  id?: string;
  name?: string;
  narrative?: string;
}

/**
 * An issued OB 3.0 credential. `document` is the signed credential exactly as issued; it never
 * changes (a correction is a reissue). "Expired" is computed from `valid_until`, never stored.
 * The recipient's claim link carries a 256-bit token of which only the SHA-256 is stored.
 */
export const credential = pgTable(
  'credential',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    issuerId: uuid('issuer_id')
      .notNull()
      .references(() => issuer.id),
    achievementId: uuid('achievement_id')
      .notNull()
      .references(() => achievement.id),
    achievementRevision: integer('achievement_revision').notNull(),
    /** The badge image it was issued with (for baking). */
    imageFileId: uuid('image_file_id').references(() => file.id),
    /** CSV batch (M4). */
    batchId: uuid('batch_id'),
    /** Normalized (trimmed, lowercase). Never shown on public pages. */
    recipientEmail: text('recipient_email').notNull(),
    recipientName: text('recipient_name').notNull(),
    /** Salt of the hashed email identifier in the credential. */
    emailSalt: text('email_salt').notNull(),
    status: text('status', { enum: CREDENTIAL_STATUS_VALUES }).notNull().default('issued'),
    validFrom: timestamptz('valid_from').notNull(),
    validUntil: timestamptz('valid_until'),
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    signingKeyId: uuid('signing_key_id')
      .notNull()
      .references(() => signingKey.id),
    statusListId: uuid('status_list_id').references(() => statusList.id),
    statusListIndex: integer('status_list_index'),
    evidence: jsonb('evidence').$type<EvidenceData[]>().notNull().default([]),
    visibility: text('visibility', { enum: CREDENTIAL_VISIBILITY_VALUES })
      .notNull()
      .default('public'),
    claimTokenHash: text('claim_token_hash').unique(),
    claimTokenExpiresAt: timestamptz('claim_token_expires_at'),
    /** When the recipient first opened their claim link ("opened" in the delivery timeline). */
    acceptedAt: timestamptz('accepted_at'),
    revokedAt: timestamptz('revoked_at'),
    revocationReason: text('revocation_reason'),
    replacedById: uuid('replaced_by_id').references((): AnyPgColumn => credential.id),
    issuedByType: text('issued_by_type', { enum: ISSUED_BY_TYPES }).notNull(),
    issuedById: text('issued_by_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('credential_org_created_idx').on(table.orgId, table.createdAt),
    index('credential_achievement_idx').on(table.achievementId),
    index('credential_org_email_idx').on(table.orgId, table.recipientEmail),
    uniqueIndex('credential_status_entry_idx').on(table.statusListId, table.statusListIndex),
    check('credential_status_check', oneOf(table.status, CREDENTIAL_STATUS_VALUES)),
    check('credential_visibility_check', oneOf(table.visibility, CREDENTIAL_VISIBILITY_VALUES)),
    check('credential_issued_by_type_check', oneOf(table.issuedByType, ISSUED_BY_TYPES)),
  ],
);

// ---- Email delivery ----

export const EMAIL_STATUS_VALUES = [
  'queued',
  'sent',
  'delivered',
  'bounced',
  'dropped',
  'spam_reported',
  'failed',
] as const;

/** One event from the email provider, kept for the delivery timeline. */
export interface EmailEventData {
  event: string;
  at: string;
  reason?: string;
}

/**
 * Award emails and their delivery status (design plan §8.4): queued → sent → delivered, or
 * bounced / dropped / failed. SendGrid's signed Event Webhook updates it.
 */
export const emailMessage = pgTable(
  'email_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    credentialId: uuid('credential_id').references(() => credential.id),
    /** Template name, e.g. `award`. */
    kind: text('kind').notNull(),
    toEmail: text('to_email').notNull(),
    status: text('status', { enum: EMAIL_STATUS_VALUES }).notNull().default('queued'),
    /** `sendgrid`, `smtp` or `log`, once sent. */
    transport: text('transport'),
    providerMessageId: text('provider_message_id'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    events: jsonb('events').$type<EmailEventData[]>().notNull().default([]),
    sentAt: timestamptz('sent_at'),
    deliveredAt: timestamptz('delivered_at'),
    bouncedAt: timestamptz('bounced_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('email_message_credential_idx').on(table.credentialId),
    index('email_message_org_created_idx').on(table.orgId, table.createdAt),
    index('email_message_provider_id_idx').on(table.providerMessageId),
    check('email_message_status_check', oneOf(table.status, EMAIL_STATUS_VALUES)),
  ],
);

// ---- Audit ----

export const AUDIT_ACTOR_TYPES = ['user', 'system', 'api_key', 'recipient'] as const;

/**
 * Append-only log of every change. Triggers reject UPDATE, DELETE and TRUNCATE for every role,
 * and the app's database role is granted only SELECT and INSERT (see `grantAppRole`).
 * No foreign keys: events outlive the rows they describe, and nothing may cascade into them.
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** Null for events that belong to no org (sign-in methods, platform admin grants). */
    orgId: uuid('org_id'),
    actorType: text('actor_type', { enum: AUDIT_ACTOR_TYPES }).notNull(),
    actorId: text('actor_id'),
    /** The actor's email (or name) at the time, so the event stays readable later. */
    actorLabel: text('actor_label'),
    /** Dotted, past tense: `org.created`, `member.role_changed`, `issuer.updated`. */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    index('audit_event_org_idx').on(table.orgId, table.id),
    index('audit_event_actor_idx').on(table.actorId),
    check('audit_event_actor_type_check', oneOf(table.actorType, AUDIT_ACTOR_TYPES)),
  ],
);
