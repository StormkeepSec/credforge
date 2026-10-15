import {
  type OrgRole,
  type OrgStatus,
  type Permission,
  permissionsFor,
  roleHasPermission,
} from '@credforge/contracts';
import { and, eq, member, organization } from '@credforge/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type AuthContext, requireReadySession } from '../api/auth-context';
import { ApiError, forbidden, notFound, uuidParam } from '../api/errors';
import type { Services } from '../services';

/** The caller's membership of the org named in the path. */
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
  memberId: string;
  role: OrgRole;
  permissions: readonly Permission[];
  actor: AuthContext;
}

const accessByRequest = new WeakMap<FastifyRequest, OrgAccess>();

/**
 * Tenant isolation for `/api/v1/orgs/:orgId/*`. Resolves the caller's membership of that org
 * before any handler runs. Someone who isn't a member gets the same 404 as for an org that
 * doesn't exist, so org ids can't be probed.
 */
export function installOrgAccess(app: FastifyInstance, { db, auth, config }: Services) {
  app.addHook('preHandler', async (request, reply) => {
    const actor = await requireReadySession({ auth, db, config }, request, reply);
    const orgId = uuidParam((request.params as { orgId?: string }).orgId, 'Organization');
    const [row] = await db
      .select({
        memberId: member.id,
        role: member.role,
        id: organization.id,
        name: organization.name,
        status: organization.status,
        statusReason: organization.statusReason,
        approvedAt: organization.approvedAt,
        dailySendLimit: organization.dailySendLimit,
        createdAt: organization.createdAt,
      })
      .from(member)
      .innerJoin(organization, eq(member.orgId, organization.id))
      .where(and(eq(member.orgId, orgId), eq(member.userId, actor.user.id)))
      .limit(1);
    if (!row) throw notFound('Organization');
    accessByRequest.set(request, {
      org: {
        id: row.id,
        name: row.name,
        status: row.status,
        statusReason: row.statusReason,
        approvedAt: row.approvedAt,
        dailySendLimit: row.dailySendLimit,
        createdAt: row.createdAt,
      },
      memberId: row.memberId,
      role: row.role,
      permissions: permissionsFor(row.role),
      actor,
    });
  });
}

export function orgAccessOf(request: FastifyRequest): OrgAccess {
  const access = accessByRequest.get(request);
  if (!access) throw new Error('Org access was not resolved for this route.');
  return access;
}

/** The caller's access, after checking they hold `permission` in this org. */
export function requirePermission(request: FastifyRequest, permission: Permission): OrgAccess {
  const access = orgAccessOf(request);
  if (!roleHasPermission(access.role, permission)) throw forbidden();
  return access;
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
