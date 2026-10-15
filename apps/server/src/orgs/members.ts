import { canManageMember, type Member, updateMemberInput } from '@credforge/contracts';
import { and, asc, eq, member, type Queryable, user } from '@credforge/db';
import type { FastifyPluginAsync } from 'fastify';
import { ApiError, forbidden, notFound, parse, uuidParam } from '../api/errors';
import { recordAudit } from '../audit/audit';
import type { Services } from '../services';
import { orgAccessOf, requestInfo, requirePermission, requireWritable, userActor } from './access';
import { countOwners, lockOrg } from './service';

async function findMember(tx: Queryable, orgId: string, memberId: string) {
  const [row] = await tx
    .select({
      id: member.id,
      userId: member.userId,
      role: member.role,
      email: user.email,
      name: user.name,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(and(eq(member.orgId, orgId), eq(member.id, memberId)))
    .limit(1);
  if (!row) throw notFound('Member');
  return row;
}

const lastOwner = () =>
  new ApiError(
    409,
    'last_owner',
    'An organization needs an owner',
    'Make someone else an owner first.',
  );

/** `/api/v1/orgs/:orgId/members`. */
export const memberRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const { db } = services;

  app.get('/members', async (request): Promise<{ members: Member[] }> => {
    const access = requirePermission(request, 'member:read');
    const rows = await db
      .select({
        id: member.id,
        userId: member.userId,
        role: member.role,
        createdAt: member.createdAt,
        name: user.name,
        email: user.email,
        twoFactorEnabled: user.twoFactorEnabled,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.orgId, access.org.id))
      .orderBy(asc(member.createdAt));
    return {
      members: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    };
  });

  app.patch('/members/:memberId', async (request) => {
    const access = requirePermission(request, 'member:manage');
    requireWritable(access);
    const memberId = uuidParam((request.params as { memberId?: string }).memberId, 'Member');
    const { role } = parse(updateMemberInput, request.body);

    await db.transaction(async (tx) => {
      await lockOrg(tx, access.org.id);
      const target = await findMember(tx, access.org.id, memberId);
      if (target.role === role) return;
      if (!canManageMember(access.role, target.role, role)) throw forbidden();
      if (target.role === 'owner' && (await countOwners(tx, access.org.id)) <= 1) {
        throw lastOwner();
      }
      await tx
        .update(member)
        .set({ role, updatedAt: new Date() })
        .where(and(eq(member.orgId, access.org.id), eq(member.id, memberId)));
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: userActor(access.actor),
        action: 'member.role_changed',
        target: { type: 'member', id: memberId },
        data: { userId: target.userId, email: target.email, from: target.role, to: role },
        request: requestInfo(request),
      });
    });
    return { id: memberId, role };
  });

  /** Removes a member. Anyone may remove themselves (leave), except the last owner. */
  app.delete('/members/:memberId', async (request, reply) => {
    const access = orgAccessOf(request);
    const memberId = uuidParam((request.params as { memberId?: string }).memberId, 'Member');
    const leaving = memberId === access.memberId;
    if (!leaving) {
      requirePermission(request, 'member:manage');
      requireWritable(access);
    }

    await db.transaction(async (tx) => {
      await lockOrg(tx, access.org.id);
      const target = await findMember(tx, access.org.id, memberId);
      if (!leaving && !canManageMember(access.role, target.role)) throw forbidden();
      if (target.role === 'owner' && (await countOwners(tx, access.org.id)) <= 1) {
        throw lastOwner();
      }
      await tx.delete(member).where(and(eq(member.orgId, access.org.id), eq(member.id, memberId)));
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: userActor(access.actor),
        action: leaving ? 'member.left' : 'member.removed',
        target: { type: 'member', id: memberId },
        data: { userId: target.userId, email: target.email, role: target.role },
        request: requestInfo(request),
      });
    });
    return reply.code(204).send();
  });
};
