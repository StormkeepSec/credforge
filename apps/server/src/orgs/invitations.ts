import { createHash, randomBytes } from 'node:crypto';
import {
  assignableRoles,
  type Invitation,
  type InvitationForRecipient,
  type InvitationPreview,
  inviteMemberInput,
  type OrgRole,
} from '@credforge/contracts';
import {
  and,
  type Database,
  desc,
  eq,
  gt,
  invitation,
  member,
  organization,
  type Queryable,
  user,
} from '@credforge/db';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AuthContext } from '../api/auth-context';
import { requireReadySession } from '../api/auth-context';
import { ApiError, forbidden, notFound, parse, uuidParam } from '../api/errors';
import { recordAudit } from '../audit/audit';
import { invitationMessage } from '../email/messages';
import type { Services } from '../services';
import { requestInfo, requirePermission, requireWritable, userActor } from './access';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A 256-bit token for the invitation link; only its hash is stored. */
export function newInvitationToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const invalidInvitation = () =>
  new ApiError(
    404,
    'invitation_invalid',
    'Invitation not found',
    'The invitation link is invalid, expired or already used. Ask for a new one.',
  );

async function sendInvitation(
  services: Services,
  input: {
    to: string;
    orgName: string;
    inviterName: string;
    role: OrgRole;
    token: string;
    expiresAt: Date;
  },
) {
  await services.outbox.send(
    invitationMessage({
      to: input.to,
      orgName: input.orgName,
      inviterName: input.inviterName,
      role: input.role,
      url: `${services.config.publicBaseUrl}/invite/${input.token}`,
      expiresAt: input.expiresAt,
    }),
  );
}

/** `/api/v1/orgs/:orgId/invitations`: invite people and manage open invitations. */
export const invitationRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const { db } = services;

  app.get('/invitations', async (request): Promise<{ invitations: Invitation[] }> => {
    const access = requirePermission(request, 'member:invite');
    const rows = await db
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
        inviterId: user.id,
        inviterName: user.name,
      })
      .from(invitation)
      .leftJoin(user, eq(invitation.invitedBy, user.id))
      .where(and(eq(invitation.orgId, access.org.id), eq(invitation.status, 'pending')))
      .orderBy(desc(invitation.createdAt));
    return {
      invitations: rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        invitedBy: row.inviterId ? { id: row.inviterId, name: row.inviterName ?? '' } : null,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });

  /** Invites someone. Inviting an address that already has an open invitation sends a fresh link. */
  app.post('/invitations', async (request, reply) => {
    const access = requirePermission(request, 'member:invite');
    requireWritable(access);
    const { email, role } = parse(inviteMemberInput, request.body);
    if (!assignableRoles(access.role).includes(role)) {
      throw forbidden(`Your role can't invite someone as ${role}.`);
    }

    const { token, hash } = newInvitationToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const result = await db.transaction(async (tx) => {
      const [existingMember] = await tx
        .select({ id: member.id })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(and(eq(member.orgId, access.org.id), eq(user.email, email)))
        .limit(1);
      if (existingMember) {
        throw new ApiError(
          409,
          'already_member',
          'Already a member',
          `${email} is already a member.`,
        );
      }
      const [open] = await tx
        .select({ id: invitation.id })
        .from(invitation)
        .where(
          and(
            eq(invitation.orgId, access.org.id),
            eq(invitation.email, email),
            eq(invitation.status, 'pending'),
          ),
        )
        .for('update');
      const values = {
        role,
        tokenHash: hash,
        expiresAt,
        invitedBy: access.actor.user.id,
        updatedAt: new Date(),
      };
      const [row] = open
        ? await tx.update(invitation).set(values).where(eq(invitation.id, open.id)).returning()
        : await tx
            .insert(invitation)
            .values({ ...values, orgId: access.org.id, email })
            .returning();
      if (!row) throw new Error('Invitation write returned no row.');
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: userActor(access.actor),
        action: open ? 'invitation.renewed' : 'invitation.created',
        target: { type: 'invitation', id: row.id },
        data: { email, role },
        request: requestInfo(request),
      });
      return row;
    });

    await sendInvitation(services, {
      to: email,
      orgName: access.org.name,
      inviterName: access.actor.user.name,
      role,
      token,
      expiresAt,
    });
    const body: Invitation = {
      id: result.id,
      email: result.email,
      role: result.role,
      invitedBy: { id: access.actor.user.id, name: access.actor.user.name },
      expiresAt: result.expiresAt.toISOString(),
      createdAt: result.createdAt.toISOString(),
    };
    return reply.code(201).send(body);
  });

  /** Sends a new link (the old one stops working) and restarts the expiry clock. */
  app.post('/invitations/:invitationId/resend', async (request) => {
    const access = requirePermission(request, 'member:invite');
    requireWritable(access);
    const id = uuidParam((request.params as { invitationId?: string }).invitationId, 'Invitation');
    const { token, hash } = newInvitationToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(invitation)
        .set({ tokenHash: hash, expiresAt, updatedAt: new Date() })
        .where(
          and(
            eq(invitation.orgId, access.org.id),
            eq(invitation.id, id),
            eq(invitation.status, 'pending'),
          ),
        )
        .returning();
      if (!updated) throw notFound('Invitation');
      if (!assignableRoles(access.role).includes(updated.role)) throw forbidden();
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: userActor(access.actor),
        action: 'invitation.resent',
        target: { type: 'invitation', id },
        data: { email: updated.email, role: updated.role },
        request: requestInfo(request),
      });
      return updated;
    });

    await sendInvitation(services, {
      to: row.email,
      orgName: access.org.name,
      inviterName: access.actor.user.name,
      role: row.role,
      token,
      expiresAt,
    });
    return { id, expiresAt: expiresAt.toISOString() };
  });

  app.delete('/invitations/:invitationId', async (request, reply) => {
    const access = requirePermission(request, 'member:invite');
    requireWritable(access);
    const id = uuidParam((request.params as { invitationId?: string }).invitationId, 'Invitation');
    await db.transaction(async (tx) => {
      const [revoked] = await tx
        .update(invitation)
        .set({ status: 'revoked', updatedAt: new Date() })
        .where(
          and(
            eq(invitation.orgId, access.org.id),
            eq(invitation.id, id),
            eq(invitation.status, 'pending'),
          ),
        )
        .returning({ email: invitation.email, role: invitation.role });
      if (!revoked) throw notFound('Invitation');
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: userActor(access.actor),
        action: 'invitation.revoked',
        target: { type: 'invitation', id },
        data: revoked,
        request: requestInfo(request),
      });
    });
    return reply.code(204).send();
  });
};

/** By the link's token, or by id for the invited address itself (from `/api/v1/me`). */
type InvitationLookup = { tokenHash: string } | { id: string; email: string };

async function findOpenInvitation(db: Queryable, lookup: InvitationLookup, lock = false) {
  const query = db
    .select({
      id: invitation.id,
      orgId: invitation.orgId,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      orgName: organization.name,
      inviterName: user.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(invitation.orgId, organization.id))
    .leftJoin(user, eq(invitation.invitedBy, user.id))
    .where(
      and(
        'tokenHash' in lookup
          ? eq(invitation.tokenHash, lookup.tokenHash)
          : and(eq(invitation.id, lookup.id), eq(invitation.email, lookup.email.toLowerCase())),
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for('update', { of: invitation }) : await query;
  return row;
}

function forRecipient(
  row: NonNullable<Awaited<ReturnType<typeof findOpenInvitation>>>,
): InvitationForRecipient {
  return {
    id: row.id,
    org: { id: row.orgId, name: row.orgName },
    role: row.role,
    invitedByName: row.inviterName,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** Pending invitations to a verified address, for `/api/v1/me`. */
export async function invitationsForEmail(
  db: Database,
  email: string,
): Promise<InvitationForRecipient[]> {
  const rows = await db
    .select({
      id: invitation.id,
      orgId: invitation.orgId,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      orgName: organization.name,
      inviterName: user.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(invitation.orgId, organization.id))
    .leftJoin(user, eq(invitation.invitedBy, user.id))
    .where(
      and(
        eq(invitation.email, email.toLowerCase()),
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(invitation.createdAt));
  return rows.map(forRecipient);
}

/**
 * Accepts an invitation for the signed-in user. Any sign-in method works, as long as the
 * account's verified email is the invited address (design plan §6.4).
 */
async function acceptInvitation(
  services: Services,
  actor: AuthContext,
  lookup: InvitationLookup,
  request: FastifyRequest,
) {
  return services.db.transaction(async (tx) => {
    const row = await findOpenInvitation(tx, lookup, true);
    if (!row) throw invalidInvitation();
    if (!actor.user.emailVerified || actor.user.email.toLowerCase() !== row.email) {
      throw new ApiError(
        403,
        'invitation_email_mismatch',
        'This invitation is for another address',
        `Sign in with ${row.email} to accept it.`,
      );
    }
    const [existing] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.orgId, row.orgId), eq(member.userId, actor.user.id)))
      .limit(1);
    if (!existing) {
      await tx.insert(member).values({ orgId: row.orgId, userId: actor.user.id, role: row.role });
    }
    await tx
      .update(invitation)
      .set({
        status: 'accepted',
        acceptedBy: actor.user.id,
        acceptedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(invitation.id, row.id));
    await recordAudit(tx, {
      orgId: row.orgId,
      actor: userActor(actor),
      action: existing ? 'invitation.accepted' : 'member.joined',
      target: { type: 'invitation', id: row.id },
      data: { email: row.email, role: row.role, alreadyMember: Boolean(existing) },
      request: requestInfo(request),
    });
    return { org: { id: row.orgId, name: row.orgName }, role: row.role };
  });
}

/** Invitation links (`/invite/{token}`) and the signed-in user's own invitations. */
export const publicInvitationRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const { db } = services;

  /** What the invitation page shows before sign-in. Knowing the token is the permission. */
  app.get('/invitations/:token', async (request): Promise<InvitationPreview> => {
    const { token } = request.params as { token: string };
    const row = await findOpenInvitation(db, { tokenHash: hashInvitationToken(token) });
    if (!row) throw invalidInvitation();
    return { ...forRecipient(row), email: row.email };
  });

  app.post('/invitations/:token/accept', async (request, reply) => {
    const actor = await requireReadySession(services, request, reply);
    const { token } = request.params as { token: string };
    return acceptInvitation(services, actor, { tokenHash: hashInvitationToken(token) }, request);
  });

  app.post('/me/invitations/:invitationId/accept', async (request, reply) => {
    const actor = await requireReadySession(services, request, reply);
    const id = uuidParam((request.params as { invitationId?: string }).invitationId, 'Invitation');
    return acceptInvitation(services, actor, { id, email: actor.user.email }, request);
  });
};
