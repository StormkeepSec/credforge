import { createOrgInput, permissionsFor, updateOrgInput } from '@credforge/contracts';
import { and, eq, member, organization, sql } from '@credforge/db';
import type { FastifyPluginAsync } from 'fastify';
import { requireReadySession } from '../api/auth-context';
import { ApiError, parse } from '../api/errors';
import { recordAudit } from '../audit/audit';
import { orgSubmittedMessage } from '../email/messages';
import { reviewOrgName } from '../moderation/subjects';
import type { Services } from '../services';
import {
  orgAccessOf,
  requestInfo,
  requireMember,
  requirePermission,
  requireWritable,
  userActor,
} from './access';
import { platformAdminEmails, serializeOrgDetails } from './service';

/** How many orgs one person may have waiting for approval at once. */
export const MAX_PENDING_ORGS_PER_USER = 3;

/** `POST /api/v1/orgs`: create an organization; the creator becomes its owner. */
export const userOrgRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const { db, config, outbox } = services;

  app.post('/orgs', async (request, reply) => {
    const actor = await requireReadySession(services, request, reply);
    const input = parse(createOrgInput, request.body);

    if (config.signupMode === 'invite' && !actor.user.isPlatformAdmin) {
      throw new ApiError(
        403,
        'signup_closed',
        'Organizations are created by invitation',
        'On this instance, a platform admin creates organizations.',
      );
    }
    // On an approval instance a new org waits for a platform admin, unless one creates it.
    const status =
      config.signupMode === 'approval' && !actor.user.isPlatformAdmin ? 'pending' : 'active';
    const now = new Date();

    const created = await db.transaction(async (tx) => {
      if (status === 'pending') {
        const [pending] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(organization)
          .where(
            and(eq(organization.createdBy, actor.user.id), eq(organization.status, 'pending')),
          );
        if ((pending?.count ?? 0) >= MAX_PENDING_ORGS_PER_USER) {
          throw new ApiError(
            409,
            'conflict',
            'Too many organizations waiting',
            `You already have ${MAX_PENDING_ORGS_PER_USER} organizations waiting for approval.`,
          );
        }
      }
      const [org] = await tx
        .insert(organization)
        .values({
          name: input.name,
          status,
          createdBy: actor.user.id,
          ...(status === 'active' && { approvedBy: actor.user.id, approvedAt: now }),
          statusChangedAt: now,
        })
        .returning();
      if (!org) throw new Error('Insert returned no row.');
      await reviewOrgName(tx, config.moderation, org, actor.user.id);
      const [owner] = await tx
        .insert(member)
        .values({ orgId: org.id, userId: actor.user.id, role: 'owner' })
        .returning({ id: member.id });
      await recordAudit(tx, {
        orgId: org.id,
        actor: userActor(actor),
        action: 'org.created',
        target: { type: 'organization', id: org.id },
        data: { name: org.name, status },
        request: requestInfo(request),
      });
      return { org, memberId: owner?.id ?? '' };
    });

    if (status === 'pending') {
      for (const to of await platformAdminEmails(db)) {
        await outbox.send(
          orgSubmittedMessage({
            to,
            orgName: created.org.name,
            requesterName: actor.user.name,
            requesterEmail: actor.user.email,
            url: `${config.publicBaseUrl}/app/platform`,
          }),
        );
      }
    }

    return reply.code(201).send(
      serializeOrgDetails(
        {
          org: created.org,
          member: { role: 'owner' },
          permissions: permissionsFor('owner'),
        },
        config.defaultOrgDailySendLimit,
      ),
    );
  });
};

/** `/api/v1/orgs/:orgId`: read and rename the org. */
export const orgRoutes: FastifyPluginAsync<{ services: Services }> = async (app, { services }) => {
  const { db, config } = services;

  app.get('/', async (request) =>
    serializeOrgDetails(requireMember(orgAccessOf(request)), config.defaultOrgDailySendLimit),
  );

  app.patch('/', async (request) => {
    const access = requireMember(requirePermission(request, 'org:update'));
    requireWritable(access);
    const input = parse(updateOrgInput, request.body);
    if (input.name !== access.org.name) {
      await db.transaction(async (tx) => {
        await tx
          .update(organization)
          .set({ name: input.name, updatedAt: new Date() })
          .where(eq(organization.id, access.org.id));
        await reviewOrgName(
          tx,
          config.moderation,
          { ...access.org, name: input.name },
          access.userId,
        );
        await recordAudit(tx, {
          orgId: access.org.id,
          actor: access.actor,
          action: 'org.updated',
          target: { type: 'organization', id: access.org.id },
          data: { name: { from: access.org.name, to: input.name } },
          request: requestInfo(request),
        });
      });
    }
    return serializeOrgDetails(
      { ...access, org: { ...access.org, name: input.name } },
      config.defaultOrgDailySendLimit,
    );
  });
};
