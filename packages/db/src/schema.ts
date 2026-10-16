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

// ---- API keys ----

/**
 * Keys for integrations (design plan §10, §12). A key is `cf_{prefix}_{secret}`: the prefix finds
 * the row, and only the SHA-256 of the whole key is stored. It is shown once, when it is created.
 * Keys belong to the org, not to the member who created them.
 */
export const apiKey = pgTable(
  'api_key',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    prefix: text('prefix').notNull().unique(),
    /** Hex SHA-256 of the whole key. */
    keyHash: text('key_hash').notNull(),
    /** Permissions the key holds (a subset of `API_KEY_SCOPES` in the contracts). */
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    expiresAt: timestamptz('expires_at'),
    /** Updated at most once a minute. */
    lastUsedAt: timestamptz('last_used_at'),
    lastUsedIp: text('last_used_ip'),
    revokedAt: timestamptz('revoked_at'),
    revokedBy: uuid('revoked_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [index('api_key_org_idx').on(table.orgId, table.createdAt)],
);

// ---- Issuers ----

export const DOMAIN_VERIFICATION_METHODS = ['dns', 'file'] as const;

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
    /** The issuer's own website: self-reported unless its domain is verified. */
    url: text('url'),
    /** Public contact address. */
    email: text('email'),
    /** The logo (a `file` of kind `issuer_logo`), embedded in the profile and in credentials. */
    imageFileId: uuid('image_file_id').references((): AnyPgColumn => file.id),
    /**
     * Domain verification (design plan §6.3). `domain_token` is what the issuer publishes in a DNS
     * TXT record or at `/.well-known/credforge-verify.txt`; `domain` is the website host it was
     * proven for. Changing the website to another host clears the proof.
     */
    domainToken: text('domain_token'),
    domain: text('domain'),
    domainVerifiedAt: timestamptz('domain_verified_at'),
    domainVerificationMethod: text('domain_verification_method', {
      enum: DOMAIN_VERIFICATION_METHODS,
    }),
    /** The last re-check, and how many in a row failed (verification lapses after a few). */
    domainCheckedAt: timestamptz('domain_checked_at'),
    domainCheckFailures: integer('domain_check_failures').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('issuer_org_id_idx').on(table.orgId),
    index('issuer_domain_verified_idx')
      .on(table.domainCheckedAt)
      .where(sql`${table.domainVerifiedAt} is not null`),
    check(
      'issuer_domain_verification_method_check',
      sql`"domain_verification_method" is null or ${oneOf(table.domainVerificationMethod, DOMAIN_VERIFICATION_METHODS)}`,
    ),
  ],
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
    /**
     * Set when a bit in `statuses` changed after `document` was signed (a revocation). The worker
     * re-signs and publishes the list, then clears it (design plan §8.6).
     */
    needsPublish: boolean('needs_publish').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('status_list_issuer_number_idx').on(table.issuerId, table.listNumber),
    index('status_list_needs_publish_idx').on(table.id).where(sql`${table.needsPublish}`),
    check('status_list_purpose_check', oneOf(table.purpose, STATUS_PURPOSE_VALUES)),
  ],
);

// ---- Batches (award many from a CSV file or JSON rows) ----

export const BATCH_SOURCE_VALUES = ['csv', 'api'] as const;
/**
 * `draft`: uploaded; the column mapping and options can still change. `queued`: confirmed, the
 * job is waiting. `running`: the worker is issuing. `completed`: every row was handled (some may
 * have failed). `failed`: the batch stopped before the end (see `error`).
 */
export const BATCH_STATUS_VALUES = ['draft', 'queued', 'running', 'completed', 'failed'] as const;

/** What a CSV column holds. `custom` columns are kept with the credential but not signed. */
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

/** One column of the uploaded file and where its values go. */
export interface BatchColumn {
  header: string;
  target: BatchColumnTarget;
}

export interface BatchOptions {
  /** Email each recipient their claim link. */
  sendEmail: boolean;
  /** Award again to people who already hold the achievement (default: skip them). */
  awardExisting: boolean;
}

/**
 * A bulk award (design plan §8.3). Rows live in `issuance_batch_row`; counts are computed from
 * them. A batch is issued by the worker in chunks, and every row is issued at most once.
 */
export const issuanceBatch = pgTable(
  'issuance_batch',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    achievementId: uuid('achievement_id')
      .notNull()
      .references(() => achievement.id),
    source: text('source', { enum: BATCH_SOURCE_VALUES }).notNull(),
    /** The uploaded CSV (a private `csv_import` file), deleted after 30 days. */
    fileId: uuid('file_id').references(() => file.id, { onDelete: 'set null' }),
    fileName: text('file_name'),
    /** Whether the file's first line holds column names. */
    hasHeader: boolean('has_header').notNull().default(true),
    columns: jsonb('columns').$type<BatchColumn[]>().notNull().default([]),
    options: jsonb('options')
      .$type<BatchOptions>()
      .notNull()
      .default({ sendEmail: true, awardExisting: false }),
    status: text('status', { enum: BATCH_STATUS_VALUES }).notNull().default('draft'),
    totalRows: integer('total_rows').notNull().default(0),
    /** Why a `failed` batch stopped. */
    error: text('error'),
    createdByType: text('created_by_type', { enum: ['user', 'api_key'] }).notNull(),
    createdById: text('created_by_id'),
    /** Who confirmed it (a user or an API key): the worker issues on their behalf. */
    confirmedByType: text('confirmed_by_type', { enum: ['user', 'api_key'] }),
    confirmedById: text('confirmed_by_id'),
    confirmedAt: timestamptz('confirmed_at'),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('issuance_batch_org_created_idx').on(table.orgId, table.createdAt),
    index('issuance_batch_active_idx')
      .on(table.status)
      .where(sql`${table.status} in ('queued', 'running')`),
    check('issuance_batch_status_check', oneOf(table.status, BATCH_STATUS_VALUES)),
    check('issuance_batch_source_check', oneOf(table.source, BATCH_SOURCE_VALUES)),
    check('issuance_batch_created_by_type_check', oneOf(table.createdByType, ['user', 'api_key'])),
    check(
      'issuance_batch_confirmed_by_type_check',
      sql`"confirmed_by_type" is null or ${oneOf(table.confirmedByType, ['user', 'api_key'])}`,
    ),
  ],
);

/** A row's values once mapped and normalized. */
export interface BatchRowValues {
  name: string;
  email: string;
  issuedOn?: string;
  expiresOn?: string;
  evidenceUrl?: string;
  custom: Record<string, string>;
}

/** A problem found when a row was checked. */
export interface BatchRowIssue {
  /** The mapped field, e.g. `email`. */
  field: string;
  message: string;
}

/**
 * What checking a row found. `ready`: will be awarded. `invalid`: a required value is missing or
 * wrong. `duplicate`: the same email appears on an earlier row. `existing`: the person already
 * holds this achievement (skipped unless the batch awards again).
 */
export const BATCH_ROW_VALIDATION_VALUES = ['ready', 'invalid', 'duplicate', 'existing'] as const;
/** Before confirming every row is `draft`; then `pending` until it is `issued` or `failed`. */
export const BATCH_ROW_STATUS_VALUES = ['draft', 'pending', 'issued', 'failed', 'skipped'] as const;

export const issuanceBatchRow = pgTable(
  'issuance_batch_row',
  {
    batchId: uuid('batch_id')
      .notNull()
      .references(() => issuanceBatch.id, { onDelete: 'cascade' }),
    /** 1 for the first data row (the header line isn't counted). */
    rowNumber: integer('row_number').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    /** The row as read from the file, so the mapping can change. */
    cells: jsonb('cells').$type<string[]>().notNull(),
    values: jsonb('values').$type<BatchRowValues>(),
    validation: text('validation', { enum: BATCH_ROW_VALIDATION_VALUES })
      .notNull()
      .default('invalid'),
    issues: jsonb('issues').$type<BatchRowIssue[]>().notNull().default([]),
    status: text('status', { enum: BATCH_ROW_STATUS_VALUES }).notNull().default('draft'),
    credentialId: uuid('credential_id').references((): AnyPgColumn => credential.id),
    /** A problem code (`send_limit_reached`, …) when issuing failed or the row was skipped. */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    processedAt: timestamptz('processed_at'),
    /**
     * When the person on this row had their data erased (design plan §12.1): `cells` and `values`
     * are emptied and the row is never checked or awarded again.
     */
    erasedAt: timestamptz('erased_at'),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.rowNumber] }),
    index('issuance_batch_row_status_idx').on(table.batchId, table.status),
    check(
      'issuance_batch_row_validation_check',
      oneOf(table.validation, BATCH_ROW_VALIDATION_VALUES),
    ),
    check('issuance_batch_row_status_check', oneOf(table.status, BATCH_ROW_STATUS_VALUES)),
  ],
);

// ---- Credentials ----

export const CREDENTIAL_STATUS_VALUES = ['draft', 'issued', 'revoked'] as const;
export const CREDENTIAL_VISIBILITY_VALUES = ['public', 'hidden'] as const;
export const ISSUED_BY_TYPES = ['user', 'api_key'] as const;
/** `revoked` by the issuer, or `superseded` by a corrected copy (reissue, design plan §8.6). */
export const REVOCATION_KIND_VALUES = ['revoked', 'superseded'] as const;

export interface EvidenceData {
  id?: string;
  name?: string;
  narrative?: string;
}

/**
 * An issued OB 3.0 credential. `document` is the signed credential exactly as issued; it never
 * changes (a correction is a reissue). "Expired" is computed from `valid_until`, never stored.
 * The recipient's claim link carries a 256-bit token of which only the SHA-256 is stored.
 *
 * Erasing the recipient's data (design plan §12.1) leaves a tombstone: `erased_at` is set and the
 * document, the recipient's name, email and salt, the audit key and everything else about the
 * person are cleared. The status-list entry stays, so copies of the credential verify as revoked.
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
    /** The batch that awarded it, and its row there (at most one credential per row). */
    batchId: uuid('batch_id').references((): AnyPgColumn => issuanceBatch.id),
    batchRowNumber: integer('batch_row_number'),
    /** Normalized (trimmed, lowercase). Never shown on public pages. Null once erased. */
    recipientEmail: text('recipient_email'),
    recipientName: text('recipient_name'),
    /** Salt of the hashed email identifier in the credential. */
    emailSalt: text('email_salt'),
    status: text('status', { enum: CREDENTIAL_STATUS_VALUES }).notNull().default('issued'),
    validFrom: timestamptz('valid_from').notNull(),
    validUntil: timestamptz('valid_until'),
    /** The signed credential; null once erased. */
    document: jsonb('document').$type<Record<string, unknown>>(),
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
    /** Why it was revoked, for the org only (required when revoking). */
    revocationReason: text('revocation_reason'),
    /** Shown on the public page, if the issuer gave one. */
    revocationPublicReason: text('revocation_public_reason'),
    revocationKind: text('revocation_kind', { enum: REVOCATION_KIND_VALUES }),
    /** The corrected copy that superseded this one, and the other way round. */
    replacedById: uuid('replaced_by_id').references((): AnyPgColumn => credential.id),
    replacesId: uuid('replaces_id').references((): AnyPgColumn => credential.id),
    /** Extra columns from a CSV batch, kept for the org's records; not signed or shown publicly. */
    customFields: jsonb('custom_fields').$type<Record<string, string>>().notNull().default({}),
    issuedByType: text('issued_by_type', { enum: ISSUED_BY_TYPES }).notNull(),
    issuedById: text('issued_by_id'),
    /**
     * Seals what audit events say about the recipient (AES-256-GCM, design plan §12.1). Erasing
     * the recipient deletes it, which leaves those parts of the append-only log unreadable.
     */
    auditKey: bytea('audit_key'),
    /** When the recipient's data was erased; the row is then a tombstone. */
    erasedAt: timestamptz('erased_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('credential_org_created_idx').on(table.orgId, table.createdAt),
    index('credential_achievement_idx').on(table.achievementId),
    index('credential_org_email_idx').on(table.orgId, table.recipientEmail),
    index('credential_org_batch_idx').on(table.orgId, table.batchId),
    uniqueIndex('credential_status_entry_idx').on(table.statusListId, table.statusListIndex),
    uniqueIndex('credential_batch_row_idx')
      .on(table.batchId, table.batchRowNumber)
      .where(sql`${table.batchId} is not null`),
    check('credential_status_check', oneOf(table.status, CREDENTIAL_STATUS_VALUES)),
    check('credential_visibility_check', oneOf(table.visibility, CREDENTIAL_VISIBILITY_VALUES)),
    check('credential_issued_by_type_check', oneOf(table.issuedByType, ISSUED_BY_TYPES)),
    check(
      'credential_revocation_kind_check',
      sql`"revocation_kind" is null or ${oneOf(table.revocationKind, REVOCATION_KIND_VALUES)}`,
    ),
    // Only an erased credential may lack its document, recipient or audit key.
    check(
      'credential_erased_check',
      sql`"erased_at" is not null or ("document" is not null and "recipient_email" is not null and "recipient_name" is not null and "email_salt" is not null and "audit_key" is not null)`,
    ),
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
    /** Null once the recipient's data was erased. */
    toEmail: text('to_email'),
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
