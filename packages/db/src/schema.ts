import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => timestamptz('created_at').notNull().defaultNow();
const updatedAt = () => timestamptz('updated_at').notNull().defaultNow();

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
