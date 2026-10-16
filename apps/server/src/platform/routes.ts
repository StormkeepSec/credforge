import {
  type OrgStatus,
  type PlatformOrg,
  platformDecisionInput,
  platformOrgLimitsInput,
  platformOrgsQuery,
} from '@credforge/contracts';
import { asc, desc, eq, inArray, issuer, member, organization, sql, user } from '@credforge/db';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { type AuthContext, requireReadySession } from '../api/auth-context';
import { ApiError, forbidden, notFound, parse, uuidParam } from '../api/errors';
import { recordAudit } from '../audit/audit';
import { orgApprovedMessage, orgDeclinedMessage, orgSuspendedMessage } from '../email/messages';
import type { EmailMessage } from '../email/transport';
import { verifiedHost } from '../issuers/domain';
import { requestInfo, userActor } from '../orgs/access';
import { lockOrg, ownerEmails } from '../orgs/service';
import type { Services } from '../services';

type Decision = 'approve' | 'decline' | 'suspend' | 'reinstate';

/** Which statuses each decision applies to, and what it leads to. */
const TRANSITIONS: Record<Decision, { from: OrgStatus[]; action: string }> = {
  approve: { from: ['pending', 'declined'], action: 'org.approved' },
  decline: { from: ['pending'], action: 'org.declined' },
  suspend: { from: ['pending', 'active'], action: 'org.suspended' },
  reinstate: { from: ['suspended'], action: 'org.reinstated' },
};

/** `/api/v1/platform`: the instance operator's approval queue (design plan §6.3). */
export const platformRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const { db, config, outbox } = services;

  const requirePlatformAdmin = async (
    request: FastifyRequest,
    reply: Parameters<typeof requireReadySession>[2],
  ) => {
    const actor = await requireReadySession(services, request, reply);
    if (!actor.user.isPlatformAdmin) throw forbidden('Only platform admins can do this.');
    return actor;
  };

  app.get('/orgs', async (request, reply): Promise<{ orgs: PlatformOrg[] }> => {
    await requirePlatformAdmin(request, reply);
    const { status } = parse(platformOrgsQuery, request.query);
    const requester = user;
    const orgs = await db
      .select({
        org: organization,
        requesterName: requester.name,
        requesterEmail: requester.email,
        memberCount: sql<number>`(select count(*)::int from ${member} where ${member.orgId} = ${organization.id})`,
      })
      .from(organization)
      .leftJoin(requester, eq(organization.createdBy, requester.id))
      .where(status ? eq(organization.status, status) : undefined)
      // Oldest first for the queue; newest first otherwise.
      .orderBy(status === 'pending' ? asc(organization.createdAt) : desc(organization.createdAt))
      .limit(500);

    const issuers = orgs.length
      ? await db
          .select({
            id: issuer.id,
            orgId: issuer.orgId,
            name: issuer.name,
            website: issuer.url,
            domain: issuer.domain,
            domainVerifiedAt: issuer.domainVerifiedAt,
          })
          .from(issuer)
          .where(
            inArray(
              issuer.orgId,
              orgs.map((row) => row.org.id),
            ),
          )
          .orderBy(asc(issuer.createdAt))
      : [];

    return {
      orgs: orgs.map(({ org, requesterName, requesterEmail, memberCount }) => ({
        id: org.id,
        name: org.name,
        status: org.status,
        statusReason: org.statusReason,
        createdAt: org.createdAt.toISOString(),
        approvedAt: org.approvedAt?.toISOString() ?? null,
        requestedBy: requesterEmail ? { name: requesterName ?? '', email: requesterEmail } : null,
        memberCount,
        issuers: issuers
          .filter((row) => row.orgId === org.id)
          .map((row) => ({
            id: row.id,
            name: row.name,
            website: row.website,
            domainVerified:
              verifiedHost({
                url: row.website,
                domain: row.domain,
                domainVerifiedAt: row.domainVerifiedAt,
              }) !== null,
          })),
        dailySendLimit: org.dailySendLimit,
        defaultDailySendLimit: config.defaultOrgDailySendLimit,
      })),
    };
  });

  const decide =
    (decision: Decision) =>
    async (request: FastifyRequest, reply: Parameters<typeof requireReadySession>[2]) => {
      const actor = await requirePlatformAdmin(request, reply);
      const orgId = uuidParam((request.params as { orgId?: string }).orgId, 'Organization');
      const { reason } = parse(platformDecisionInput, request.body);
      const transition = TRANSITIONS[decision];

      const org = await db.transaction(async (tx) => {
        await lockOrg(tx, orgId);
        const [current] = await tx.select().from(organization).where(eq(organization.id, orgId));
        if (!current) throw notFound('Organization');
        if (!transition.from.includes(current.status)) {
          throw new ApiError(
            409,
            'conflict',
            'Not possible in this state',
            `The organization is ${current.status}.`,
          );
        }
        const now = new Date();
        const next = nextState(decision, current, actor, now, reason ?? null);
        const [updated] = await tx
          .update(organization)
          .set({ ...next, statusChangedAt: now, updatedAt: now })
          .where(eq(organization.id, orgId))
          .returning();
        await recordAudit(tx, {
          orgId,
          actor: userActor(actor),
          action: transition.action,
          target: { type: 'organization', id: orgId },
          data: { from: current.status, to: next.status, reason: reason ?? null },
          request: requestInfo(request),
        });
        return updated ?? current;
      });

      const notice = (to: string): EmailMessage | null => {
        if (decision === 'approve')
          return orgApprovedMessage(to, org.name, `${config.publicBaseUrl}/app`);
        if (decision === 'decline') return orgDeclinedMessage(to, org.name, org.statusReason);
        if (decision === 'suspend') return orgSuspendedMessage(to, org.name, org.statusReason);
        return null;
      };
      for (const to of await ownerEmails(db, orgId)) {
        const message = notice(to);
        if (message) await outbox.send(message);
      }
      return { id: org.id, status: org.status, statusReason: org.statusReason };
    };

  /** Sets an org's own daily send limit (§6.3); null goes back to the instance default. */
  app.patch('/orgs/:orgId/limits', async (request, reply) => {
    const actor = await requirePlatformAdmin(request, reply);
    const orgId = uuidParam((request.params as { orgId?: string }).orgId, 'Organization');
    const { dailySendLimit } = parse(platformOrgLimitsInput, request.body);
    await db.transaction(async (tx) => {
      await lockOrg(tx, orgId);
      const [current] = await tx.select().from(organization).where(eq(organization.id, orgId));
      if (!current) throw notFound('Organization');
      if (current.dailySendLimit === dailySendLimit) return;
      await tx
        .update(organization)
        .set({ dailySendLimit, updatedAt: new Date() })
        .where(eq(organization.id, orgId));
      await recordAudit(tx, {
        orgId,
        actor: userActor(actor),
        action: 'org.limits_changed',
        target: { type: 'organization', id: orgId },
        data: { dailySendLimit: { from: current.dailySendLimit, to: dailySendLimit } },
        request: requestInfo(request),
      });
    });
    return { id: orgId, dailySendLimit, defaultDailySendLimit: config.defaultOrgDailySendLimit };
  });

  app.post('/orgs/:orgId/approve', decide('approve'));
  app.post('/orgs/:orgId/decline', decide('decline'));
  app.post('/orgs/:orgId/suspend', decide('suspend'));
  app.post('/orgs/:orgId/reinstate', decide('reinstate'));
};

function nextState(
  decision: Decision,
  current: typeof organization.$inferSelect,
  actor: AuthContext,
  now: Date,
  reason: string | null,
): Pick<typeof organization.$inferInsert, 'status' | 'statusReason' | 'approvedBy' | 'approvedAt'> {
  switch (decision) {
    case 'approve':
      return { status: 'active', statusReason: null, approvedBy: actor.user.id, approvedAt: now };
    case 'decline':
      return { status: 'declined', statusReason: reason };
    case 'suspend':
      return { status: 'suspended', statusReason: reason };
    case 'reinstate':
      // Back to where it was before the suspension: active if it had been approved.
      return { status: current.approvedAt ? 'active' : 'pending', statusReason: null };
  }
}
