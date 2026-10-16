import {
  type ApiKeyScope,
  isApiKeyScope,
  type OrgRole,
  type OrgStatus,
  type Permission,
  permissionsFor,
} from '@credforge/contracts';
import { and, apiKey, eq, isNull, member, or, organization, sql } from '@credforge/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type AuthContext, requireReadySession, type SessionUser } from '../api/auth-context';
import { ApiError, forbidden, notFound, uuidParam } from '../api/errors';
import { apiKeyScopeFor } from '../api/operations';
import type { RateLimiter } from '../api/rate-limit';
import { apiKeyMatches, apiKeyPrefix, bearerToken } from '../api-keys/keys';
import type { AuditActor } from '../audit/audit';
import type { Services } from '../services';

/** The caller's access to the org named in the path: a member signed in, or an API key. */
export interface OrgAccess {
  org: {
    id: string;
    name: string;
    status: OrgStatus;
    statusReason: string | null;
    approvedAt: Date | null;
    /** The org's own daily send limit; null uses the instance default. */
    dailySendLimit: number | null;
    createdAt: Date;
  };
  /** The member making the request; null for an API key. */
  member: { id: string; role: OrgRole; user: SessionUser; session: AuthContext } | null;
  /** The API key making the request; null for a member. */
  apiKey: { id: string; name: string; prefix: string } | null;
  /** The role's permissions, or the key's scopes. */
  permissions: readonly Permission[];
  /** Who acts, for the audit log and `issued_by`. */
  actor: Extract<AuditActor, { type: 'user' | 'api_key' }> & { label: string };
  /** The member's user id (for `created_by` columns); null for an API key. */
  userId: string | null;
}

/** A member's access (routes that never accept API keys). */
export type MemberAccess = OrgAccess & { member: NonNullable<OrgAccess['member']> };

export interface OrgAccessOptions {
  /** Requests per API key; over it, 429. */
  apiKeyLimiter: RateLimiter;
}

const accessByRequest = new WeakMap<FastifyRequest, OrgAccess>();

const ORG_COLUMNS = {
  id: organization.id,
  name: organization.name,
  status: organization.status,
  statusReason: organization.statusReason,
  approvedAt: organization.approvedAt,
  dailySendLimit: organization.dailySendLimit,
  createdAt: organization.createdAt,
};

const invalidKey = () =>
  new ApiError(
    401,
    'unauthenticated',
    'API key not valid',
    'The API key is unknown, revoked or expired.',
  );

/**
 * Tenant isolation for `/api/v1/orgs/:orgId/*`. Resolves who is calling before any handler runs:
 * a member signed in (cookies), or one of the org's API keys (`Authorization: Bearer cf_…`).
 * Someone who isn't a member, or a key of another org, gets the same 404 as for an org that
 * doesn't exist, so org ids can't be probed.
 */
export function installOrgAccess(
  app: FastifyInstance,
  services: Services,
  { apiKeyLimiter }: OrgAccessOptions,
) {
  const { db, auth, config } = services;
  app.addHook('preHandler', async (request, reply) => {
    const orgId = uuidParam((request.params as { orgId?: string }).orgId, 'Organization');
    const token = bearerToken(request.headers.authorization);
    if (request.headers.authorization) {
      const access = await keyAccess(services, request, reply, token, orgId, apiKeyLimiter);
      accessByRequest.set(request, access);
      return;
    }

    const actor = await requireReadySession({ auth, db, config }, request, reply);
    const [row] = await db
      .select({ memberId: member.id, role: member.role, ...ORG_COLUMNS })
      .from(member)
      .innerJoin(organization, eq(member.orgId, organization.id))
      .where(and(eq(member.orgId, orgId), eq(member.userId, actor.user.id)))
      .limit(1);
    if (!row) throw notFound('Organization');
    accessByRequest.set(request, {
      org: orgOf(row),
      member: { id: row.memberId, role: row.role, user: actor.user, session: actor },
      apiKey: null,
      permissions: permissionsFor(row.role),
      actor: { type: 'user', id: actor.user.id, label: actor.user.email },
      userId: actor.user.id,
    });
  });
}

async function keyAccess(
  { db }: Services,
  request: FastifyRequest,
  reply: FastifyReply,
  token: string | null,
  orgId: string,
  limiter: RateLimiter,
): Promise<OrgAccess> {
  const prefix = token ? apiKeyPrefix(token) : null;
  if (!token || !prefix) throw invalidKey();
  const [row] = await db
    .select({ key: apiKey, org: ORG_COLUMNS })
    .from(apiKey)
    .innerJoin(organization, eq(apiKey.orgId, organization.id))
    .where(eq(apiKey.prefix, prefix))
    .limit(1);
  const now = new Date();
  if (
    !row ||
    !apiKeyMatches(token, row.key.keyHash) ||
    row.key.revokedAt ||
    (row.key.expiresAt && row.key.expiresAt <= now)
  ) {
    throw invalidKey();
  }
  // Another org's key: as if the org didn't exist.
  if (row.key.orgId !== orgId) throw notFound('Organization');

  const limit = limiter.take(`api-key:${row.key.id}`, now.getTime());
  if (!limit.allowed) {
    reply.header('retry-after', String(limit.retryAfter));
    throw new ApiError(
      429,
      'rate_limited',
      'Too many requests',
      `This API key made too many requests. Try again in ${limit.retryAfter} seconds.`,
    );
  }

  const needed = apiKeyScopeFor(request.method, request.routeOptions.url ?? '');
  if (!needed) {
    throw new ApiError(
      403,
      'api_key_not_allowed',
      'Not available to API keys',
      'This endpoint needs a person signed in to the issuer app.',
    );
  }

  // Last used, at most once a minute per key.
  await db
    .update(apiKey)
    .set({ lastUsedAt: now, lastUsedIp: request.ip })
    .where(
      and(
        eq(apiKey.id, row.key.id),
        or(
          isNull(apiKey.lastUsedAt),
          sql`${apiKey.lastUsedAt} < ${new Date(now.getTime() - 60_000)}`,
        ),
      ),
    );

  const scopes = row.key.scopes.filter(isApiKeyScope) as ApiKeyScope[];
  const label = `${row.key.name} (${row.key.prefix})`;
  return {
    org: orgOf(row.org),
    member: null,
    apiKey: { id: row.key.id, name: row.key.name, prefix: row.key.prefix },
    permissions: scopes,
    actor: { type: 'api_key', id: row.key.id, label },
    userId: null,
  };
}

function orgOf(row: {
  id: string;
  name: string;
  status: OrgStatus;
  statusReason: string | null;
  approvedAt: Date | null;
  dailySendLimit: number | null;
  createdAt: Date;
}): OrgAccess['org'] {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    statusReason: row.statusReason,
    approvedAt: row.approvedAt,
    dailySendLimit: row.dailySendLimit,
    createdAt: row.createdAt,
  };
}

export function orgAccessOf(request: FastifyRequest): OrgAccess {
  const access = accessByRequest.get(request);
  if (!access) throw new Error('Org access was not resolved for this route.');
  return access;
}

/** The caller's access, after checking they hold `permission` in this org (role or key scope). */
export function requirePermission(request: FastifyRequest, permission: Permission): OrgAccess {
  const access = orgAccessOf(request);
  if (!access.permissions.includes(permission)) {
    throw forbidden(access.apiKey ? 'This API key doesn’t have that permission.' : undefined);
  }
  return access;
}

/**
 * The caller as a member. Routes that manage people (members, invitations) use it; API keys
 * never reach them (`api/operations.ts`), so this only guards against a mistake there.
 */
export function requireMember(access: OrgAccess): MemberAccess {
  if (!access.member) {
    throw new ApiError(
      403,
      'api_key_not_allowed',
      'Not available to API keys',
      'This endpoint needs a person signed in to the issuer app.',
    );
  }
  return access as MemberAccess;
}

/** Suspended and declined orgs are read-only. */
export function requireWritable(access: OrgAccess): void {
  if (access.org.status === 'suspended' || access.org.status === 'declined') {
    throw new ApiError(
      403,
      'org_inactive',
      access.org.status === 'suspended' ? 'Organization suspended' : 'Organization not approved',
      'This organization is read-only.',
    );
  }
}

export function requestInfo(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export function userActor(context: AuthContext) {
  return { type: 'user' as const, id: context.user.id, label: context.user.email };
}
