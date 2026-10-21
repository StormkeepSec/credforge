import {
  type OrgStatus,
  type PlatformOrg,
  platformDecisionInput,
  platformOrgLimitsInput,
  platformOrgsQuery,
  revokeOrgCredentialsInput,
  trustOrgInput,
} from '@credforge/contracts';
import {
  and,
  asc,
  contentReport,
  credential,
  desc,
  eq,
  file,
  inArray,
  issuer,
  member,
  moderationItem,
  organization,
  sql,
  user,
} from '@credforge/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext } from '../api/auth-context';
import { ApiError, notFound, parse, uuidParam } from '../api/errors';
import { recordAudit } from '../audit/audit';
import { revokeAllOrgCredentials } from '../credentials/revocation';
import {
  orgApprovedMessage,
  orgCredentialsRevokedMessage,
  orgDeclinedMessage,
  orgSuspendedMessage,
} from '../email/messages';
import type { EmailMessage } from '../email/transport';
import { verifiedHost } from '../issuers/domain';
import { pendingCounts } from '../moderation/queue';
import { decideItems } from '../moderation/service';
import { requestInfo, userActor } from '../orgs/access';
import { lockOrg, ownerEmails } from '../orgs/service';
import type { Services } from '../services';
import { requirePlatformAdmin as requireAdmin } from './admin';
import { moderationRoutes } from './moderation-routes';

type Decision = 'approve' | 'decline' | 'suspend' | 'reinstate';

/** Which statuses each decision applies to, and what it leads to. */
const TRANSITIONS: Record<Decision, { from: OrgStatus[]; action: string }> = {
  approve: { from: ['pending', 'declined'], action: 'org.approved' },
  decline: { from: ['pending'], action: 'org.declined' },
  suspend: { from: ['pending', 'active'], action: 'org.suspended' },
  reinstate: { from: ['suspended'], action: 'org.reinstated' },
};

/**
 * `/api/v1/platform`: the instance operator's approval queue (design plan §6.3), org limits and
 * trust, and the moderation queue (§6.5, moderation-routes.ts).
 */
export const platformRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const { db, config, outbox } = services;
  const appeal = { abuseEmail: config.abuseEmail };

  const requirePlatformAdmin = (request: FastifyRequest, reply: FastifyReply) =>
    requireAdmin(services, request, reply);

  await app.register(moderationRoutes, { services });

  app.get('/orgs', async (request, reply): Promise<{ orgs: PlatformOrg[] }> => {
    await requirePlatformAdmin(request, reply);
    const { status } = parse(platformOrgsQuery, request.query);
    const requester = user;
    const orgs = await db
      .select({
        org: organization,
        requesterId: requester.id,
        requesterName: requester.name,
        requesterEmail: requester.email,
        requesterDisabledAt: requester.disabledAt,
        memberCount: sql<number>`(select count(*)::int from ${member} where ${member.orgId} = ${organization.id})`,
        activeCredentials: sql<number>`(select count(*)::int from ${credential} where ${credential.orgId} = ${organization.id} and ${credential.status} = 'issued')`,
        openReports: sql<number>`(select count(*)::int from ${contentReport} where ${contentReport.orgId} = ${organization.id} and ${contentReport.status} = 'open')`,
        storageUsedBytes: sql<string>`(select coalesce(sum(${file.size} + coalesce((select sum((v.value->>'size')::bigint) from jsonb_each(${file.variants}) as v), 0)), 0) from ${file} where ${file.orgId} = ${organization.id})`,
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

    const pending = await pendingCounts(
      db,
      orgs.map((row) => row.org.id),
    );

    return {
      orgs: orgs.map((row) => ({
        id: row.org.id,
        name: row.org.name,
        status: row.org.status,
        statusReason: row.org.statusReason,
        createdAt: row.org.createdAt.toISOString(),
        approvedAt: row.org.approvedAt?.toISOString() ?? null,
        requestedBy:
          row.requesterId && row.requesterEmail
            ? {
                id: row.requesterId,
                name: row.requesterName ?? '',
                email: row.requesterEmail,
                disabled: row.requesterDisabledAt !== null,
              }
            : null,
        trustedAt: row.org.trustedAt?.toISOString() ?? null,
        review: { pending: pending.get(row.org.id) ?? 0, openReports: row.openReports },
        activeCredentials: row.activeCredentials,
        memberCount: row.memberCount,
        issuers: issuers
          .filter((item) => item.orgId === row.org.id)
          .map((item) => ({
            id: item.id,
            name: item.name,
            website: item.website,
            domainVerified:
              verifiedHost({
                url: item.website,
                domain: item.domain,
                domainVerifiedAt: item.domainVerifiedAt,
              }) !== null,
          })),
        dailySendLimit: row.org.dailySendLimit,
        defaultDailySendLimit: config.defaultOrgDailySendLimit,
        uploadRateLimit: row.org.uploadRateLimit,
        defaultUploadRateLimit: config.orgUploadRateLimit,
        storageQuotaMb: row.org.storageQuotaMb,
        defaultStorageQuotaMb: config.orgStorageQuotaMb,
        storageUsedBytes: Number(row.storageUsedBytes),
      })),
    };
  });

  const decide = (decision: Decision) => async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await requirePlatformAdmin(request, reply);
    const orgId = uuidParam((request.params as { orgId?: string }).orgId, 'Organization');
    const { reason, clearItemIds } = parse(platformDecisionInput, request.body);
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
      // Approving reviews the org's first content too (design plan §6.5): the items the admin
      // was shown are cleared with it; anything saved since keeps waiting.
      if (decision === 'approve' && clearItemIds && clearItemIds.length > 0) {
        const own = await tx
          .select({ id: moderationItem.id })
          .from(moderationItem)
          .where(
            and(
              eq(moderationItem.orgId, orgId),
              inArray(moderationItem.id, clearItemIds),
              eq(moderationItem.status, 'pending'),
              // Its automatic check hasn't run: it wasn't shown, and the check may clear it itself.
              sql`${moderationItem.scanStatus} is distinct from 'waiting'`,
            ),
          );
        const cleared = await decideItems(
          tx,
          own.map((row) => row.id),
          'cleared',
          { userId: actor.user.id, note: 'Cleared when the organization was approved.' },
        );
        for (const item of cleared) {
          await recordAudit(tx, {
            orgId,
            actor: userActor(actor),
            action: 'moderation.cleared',
            target: { type: 'moderation_item', id: item.id },
            data: {
              kind: item.kind,
              subject: { type: item.subjectType, id: item.subjectId },
              from: 'pending',
              note: 'Cleared when the organization was approved.',
            },
            request: requestInfo(request),
          });
        }
      }
      return updated ?? current;
    });

    const notice = (to: string): EmailMessage | null => {
      if (decision === 'approve')
        return orgApprovedMessage(to, org.name, `${config.publicBaseUrl}/app`);
      if (decision === 'decline') return orgDeclinedMessage(to, org.name, org.statusReason);
      if (decision === 'suspend') {
        return orgSuspendedMessage(to, org.name, org.statusReason, appeal);
      }
      return null;
    };
    for (const to of await ownerEmails(db, orgId)) {
      const message = notice(to);
      if (message) await outbox.send(message);
    }
    return { id: org.id, status: org.status, statusReason: org.statusReason };
  };

  /**
   * Sets an org's own limits: its daily send cap (§6.3), uploads per hour and storage quota
   * (§6.5). Null goes back to the instance default; a limit left out stays as it is.
   */
  app.patch('/orgs/:orgId/limits', async (request, reply) => {
    const actor = await requirePlatformAdmin(request, reply);
    const orgId = uuidParam((request.params as { orgId?: string }).orgId, 'Organization');
    const input = parse(platformOrgLimitsInput, request.body);
    const updated = await db.transaction(async (tx) => {
      await lockOrg(tx, orgId);
      const [current] = await tx.select().from(organization).where(eq(organization.id, orgId));
      if (!current) throw notFound('Organization');
      const changes: Record<string, { from: number | null; to: number | null }> = {};
      for (const field of ['dailySendLimit', 'uploadRateLimit', 'storageQuotaMb'] as const) {
        const value = input[field];
        if (value !== undefined && value !== current[field]) {
          changes[field] = { from: current[field], to: value };
        }
      }
      if (Object.keys(changes).length === 0) return current;
      const [row] = await tx
        .update(organization)
        .set({
          ...Object.fromEntries(Object.entries(changes).map(([field, { to }]) => [field, to])),
          updatedAt: new Date(),
        })
        .where(eq(organization.id, orgId))
        .returning();
      await recordAudit(tx, {
        orgId,
        actor: userActor(actor),
        action: 'org.limits_changed',
        target: { type: 'organization', id: orgId },
        data: changes,
        request: requestInfo(request),
      });
      return row ?? current;
    });
    return {
      id: orgId,
      dailySendLimit: updated.dailySendLimit,
      defaultDailySendLimit: config.defaultOrgDailySendLimit,
      uploadRateLimit: updated.uploadRateLimit,
      defaultUploadRateLimit: config.orgUploadRateLimit,
      storageQuotaMb: updated.storageQuotaMb,
      defaultStorageQuotaMb: config.orgStorageQuotaMb,
    };
  });

  /**
   * Marks an org trusted, or not (§6.5): with MODERATION_REVIEW=untrusted, a trusted org's new
   * images and text are published without waiting for review. What already waits keeps waiting.
   */
  app.post('/orgs/:orgId/trust', async (request, reply) => {
    const actor = await requirePlatformAdmin(request, reply);
    const orgId = uuidParam((request.params as { orgId?: string }).orgId, 'Organization');
    const { trusted } = parse(trustOrgInput, request.body);
    const trustedAt = await db.transaction(async (tx) => {
      await lockOrg(tx, orgId);
      const [current] = await tx.select().from(organization).where(eq(organization.id, orgId));
      if (!current) throw notFound('Organization');
      if (trusted === (current.trustedAt !== null)) return current.trustedAt;
      const now = new Date();
      await tx
        .update(organization)
        .set({
          trustedAt: trusted ? now : null,
          trustedBy: trusted ? actor.user.id : null,
          updatedAt: now,
        })
        .where(eq(organization.id, orgId));
      await recordAudit(tx, {
        orgId,
        actor: userActor(actor),
        action: trusted ? 'org.trusted' : 'org.untrusted',
        target: { type: 'organization', id: orgId },
        request: requestInfo(request),
      });
      return trusted ? now : null;
    });
    return { id: orgId, trustedAt: trustedAt?.toISOString() ?? null };
  });

  /**
   * Revokes every badge a suspended org awarded (abuse, §6.3), as `cli.js revoke-org-credentials`
   * does: each with its audit event, the status lists re-signed by the worker.
   */
  app.post('/orgs/:orgId/revoke-credentials', async (request, reply) => {
    const actor = await requirePlatformAdmin(request, reply);
    const orgId = uuidParam((request.params as { orgId?: string }).orgId, 'Organization');
    const input = parse(revokeOrgCredentialsInput, request.body);
    const [org] = await db.select().from(organization).where(eq(organization.id, orgId));
    if (!org) throw notFound('Organization');
    const revoked = await revokeAllOrgCredentials(
      services,
      orgId,
      { reason: input.reason, publicReason: input.publicReason ?? null },
      userActor(actor),
      requestInfo(request),
    );
    await recordAudit(db, {
      orgId,
      actor: userActor(actor),
      action: 'org.credentials_revoked',
      target: { type: 'organization', id: orgId },
      data: { revoked, reason: input.reason, publicReason: input.publicReason ?? null },
      request: requestInfo(request),
    });
    if (revoked > 0) {
      for (const to of await ownerEmails(db, orgId)) {
        await outbox.send(
          orgCredentialsRevokedMessage(to, org.name, revoked, input.reason, appeal),
        );
      }
    }
    return { id: orgId, revoked };
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
