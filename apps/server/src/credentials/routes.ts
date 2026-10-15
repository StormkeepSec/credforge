import {
  type AwardPreview,
  awardInput,
  type BulkRevokeResult,
  bulkRevokeInput,
  type CredentialPage,
  credentialsQuery,
  reissueInput,
  revokeInput,
} from '@credforge/contracts';
import { achievement, and, credential, eq, issuer, organization } from '@credforge/db';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, conflict, notFound, parse, uuidParam } from '../api/errors';
import { recordAudit } from '../audit/audit';
import { awardMessage } from '../email/messages';
import { imageSet, loadFiles } from '../files/service';
import { requestInfo, requirePermission, requireWritable, userActor } from '../orgs/access';
import type { Services } from '../services';
import { beforeCursor, credentialConditions, newestFirst } from './query';
import { reissueCredential, revokeCredential, revokeCredentials } from './revocation';
import {
  awardCredential,
  checkSendLimit,
  emailsFor,
  loadCredentialDetails,
  newClaimToken,
  queueAwardEmail,
  serializeCredentialSummary,
  serviceName,
} from './service';

const idOf = (request: FastifyRequest) =>
  uuidParam((request.params as { credentialId?: string }).credentialId, 'Credential');

/** `before` cursors are `{createdAt ISO}_{id}`. */
export function parseCursor(value: string | undefined): { at: Date; id: string } | undefined {
  if (!value) return undefined;
  const [at, id] = value.split('_');
  const date = new Date(at ?? '');
  if (!id || Number.isNaN(date.getTime()) || !z.uuid().safeParse(id).success) {
    throw new ApiError(400, 'validation_failed', 'Invalid cursor');
  }
  return { at: date, id };
}

const previewInput = z.object({
  achievementId: z.uuid('Choose an achievement'),
  recipient: z.object({ name: z.string().trim().max(200).optional() }).optional(),
});

/**
 * `/api/v1/orgs/:orgId/credentials`: awarding (design plan §8.2) and the issuer's view of what
 * was awarded and whether the email arrived (§8.4).
 */
export const credentialRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const { db, config } = services;

  app.get('/credentials', async (request): Promise<CredentialPage> => {
    const access = requirePermission(request, 'credential:read');
    const query = parse(credentialsQuery, request.query);
    const cursor = parseCursor(query.before);
    const rows = await db
      .select({
        credential,
        achievementName: achievement.name,
        imageFileId: achievement.imageFileId,
      })
      .from(credential)
      .innerJoin(achievement, eq(credential.achievementId, achievement.id))
      .where(and(credentialConditions(access.org.id, query), beforeCursor(cursor)))
      .orderBy(...newestFirst)
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const files = await loadFiles(
      db,
      page.map((row) => row.imageFileId),
    );
    const emails = await emailsFor(
      db,
      access.org.id,
      page.map((row) => row.credential.id),
    );
    const last = page.at(-1);
    return {
      credentials: page.map((row) =>
        serializeCredentialSummary(
          config.publicBaseUrl,
          row.credential,
          {
            name: row.achievementName,
            image: row.imageFileId ? files.get(row.imageFileId) : undefined,
          },
          emails.get(row.credential.id) ?? [],
        ),
      ),
      next:
        rows.length > query.limit && last
          ? `${last.credential.createdAt.toISOString()}_${last.credential.id}`
          : null,
    };
  });

  /** Awards one credential: signed, stored and emailed, or nothing at all. */
  app.post('/credentials', async (request, reply) => {
    const access = requirePermission(request, 'credential:issue');
    requireWritable(access);
    const input = parse(awardInput, request.body);
    const id = await awardCredential(
      services,
      { orgId: access.org.id },
      input,
      { type: 'user', id: access.actor.user.id, label: access.actor.user.email },
      requestInfo(request),
    );
    return reply
      .code(201)
      .send(await loadCredentialDetails(db, config.publicBaseUrl, access.org.id, id));
  });

  /** What the award email will say, for the award form's preview. Signs nothing. */
  app.post('/credentials/preview', async (request): Promise<AwardPreview> => {
    const access = requirePermission(request, 'credential:issue');
    const input = parse(previewInput, request.body);
    const [row] = await db
      .select({ achievement, issuer })
      .from(achievement)
      .innerJoin(issuer, eq(achievement.issuerId, issuer.id))
      .where(and(eq(achievement.orgId, access.org.id), eq(achievement.id, input.achievementId)));
    if (!row) throw notFound('Achievement');
    const files = await loadFiles(db, [row.achievement.imageFileId]);
    const image = row.achievement.imageFileId ? files.get(row.achievement.imageFileId) : undefined;
    const name = serviceName(config);
    const message = awardMessage({
      to: 'recipient@example.org',
      recipientName: input.recipient?.name || 'Jordan Rivera',
      issuerName: row.issuer.name,
      issuerEmail: row.issuer.email,
      achievementName: row.achievement.name,
      achievementDescription: row.achievement.description,
      imageUrl: image ? imageSet(config.publicBaseUrl, image).url512 : null,
      claimUrl: `${config.publicBaseUrl}/credentials/…`,
      claimExpiresAt: newClaimToken().expiresAt,
      serviceName: name,
    });
    return {
      email: {
        subject: message.subject,
        text: message.text,
        from: message.fromName ?? name,
        replyTo: message.replyTo ?? null,
      },
    };
  });

  app.get('/credentials/:credentialId', async (request) => {
    const access = requirePermission(request, 'credential:read');
    return loadCredentialDetails(db, config.publicBaseUrl, access.org.id, idOf(request));
  });

  /**
   * Emails the recipient a new claim link. The previous link stops working (only the newest
   * token's hash is kept), and the 90 days start again.
   */
  app.post('/credentials/:credentialId/resend', async (request) => {
    const access = requirePermission(request, 'credential:issue');
    requireWritable(access);
    const credentialId = idOf(request);
    await db.transaction(async (tx) => {
      const [org] = await tx
        .select()
        .from(organization)
        .where(eq(organization.id, access.org.id))
        .for('update');
      if (!org) throw notFound('Organization');
      const [row] = await tx
        .select({ credential, achievement, issuer })
        .from(credential)
        .innerJoin(achievement, eq(credential.achievementId, achievement.id))
        .innerJoin(issuer, eq(credential.issuerId, issuer.id))
        .where(and(eq(credential.orgId, access.org.id), eq(credential.id, credentialId)))
        .for('update', { of: credential });
      if (!row) throw notFound('Credential');
      if (row.credential.status !== 'issued') {
        throw conflict('This credential was revoked, so its link can’t be sent again.');
      }
      await checkSendLimit(tx, org, config.defaultOrgDailySendLimit);

      const claim = newClaimToken();
      await tx
        .update(credential)
        .set({
          claimTokenHash: claim.hash,
          claimTokenExpiresAt: claim.expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(credential.id, credentialId));
      const files = await loadFiles(tx, [row.credential.imageFileId]);
      await queueAwardEmail(tx, services, {
        orgId: access.org.id,
        credentialId,
        to: row.credential.recipientEmail,
        recipientName: row.credential.recipientName,
        issuer: row.issuer,
        // The email describes the achievement as it was signed into this credential.
        achievement: signedAchievement(row.credential.document) ?? row.achievement,
        image: row.credential.imageFileId ? files.get(row.credential.imageFileId) : undefined,
        token: claim.token,
        expiresAt: claim.expiresAt,
        resend: true,
      });
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: userActor(access.actor),
        action: 'credential.email_resent',
        target: { type: 'credential', id: credentialId },
        data: { to: row.credential.recipientEmail },
        request: requestInfo(request),
      });
    });
    return loadCredentialDetails(db, config.publicBaseUrl, access.org.id, credentialId);
  });

  /**
   * Revokes one credential (design plan §8.6). Its status bit is set now; the signed status list
   * is re-published by the worker a few seconds later.
   */
  app.post('/credentials/:credentialId/revoke', async (request) => {
    const access = requirePermission(request, 'credential:revoke');
    requireWritable(access);
    const credentialId = idOf(request);
    const input = parse(revokeInput, request.body);
    await revokeCredential(
      services,
      access.org.id,
      credentialId,
      input,
      userActor(access.actor),
      requestInfo(request),
    );
    return loadCredentialDetails(db, config.publicBaseUrl, access.org.id, credentialId);
  });

  /** Revokes many at once, with the same reasons. */
  app.post('/credentials/revoke', async (request): Promise<BulkRevokeResult> => {
    const access = requirePermission(request, 'credential:revoke');
    requireWritable(access);
    const input = parse(bulkRevokeInput, request.body);
    return revokeCredentials(
      services,
      access.org.id,
      input.credentialIds,
      input,
      userActor(access.actor),
      requestInfo(request),
    );
  });

  /**
   * Reissues a credential: a corrected, newly signed copy replaces it, and the old one is revoked
   * as superseded. Answers with the new credential.
   */
  app.post('/credentials/:credentialId/reissue', async (request, reply) => {
    requirePermission(request, 'credential:revoke');
    const access = requirePermission(request, 'credential:issue');
    requireWritable(access);
    const input = parse(reissueInput, request.body);
    const id = await reissueCredential(
      services,
      access.org.id,
      idOf(request),
      input,
      userActor(access.actor),
      requestInfo(request),
    );
    return reply
      .code(201)
      .send(await loadCredentialDetails(db, config.publicBaseUrl, access.org.id, id));
  });
};

/** The achievement's name and description as signed into a credential. */
function signedAchievement(document: Record<string, unknown>) {
  const subject = document.credentialSubject as
    | { achievement?: { name?: unknown; description?: unknown } }
    | undefined;
  const name = subject?.achievement?.name;
  const description = subject?.achievement?.description;
  return typeof name === 'string' && typeof description === 'string'
    ? { name, description }
    : undefined;
}
