import {
  type Achievement,
  type AchievementRevision,
  achievementInput,
  achievementsQuery,
  updateAchievementInput,
} from '@credforge/contracts';
import {
  type AchievementSnapshot,
  achievement,
  achievementRevision,
  and,
  asc,
  desc,
  eq,
  file,
  issuer,
  type Queryable,
  signingKey,
  user,
} from '@credforge/db';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ApiError, conflict, notFound, parse, uuidParam } from '../api/errors';
import { acceptImageUploads, storeUploadedImage, UPLOAD_ROUTE_OPTIONS } from '../api/uploads';
import { recordAudit } from '../audit/audit';
import { deleteFiles, loadFiles } from '../files/service';
import {
  type OrgAccess,
  requestInfo,
  requirePermission,
  requireWritable,
  userActor,
} from '../orgs/access';
import type { Services } from '../services';
import {
  type AchievementRow,
  awardedCounts,
  changedFields,
  serializeAchievement,
  snapshotOf,
} from './service';

const idOf = (request: FastifyRequest) =>
  uuidParam((request.params as { achievementId?: string }).achievementId, 'Achievement');

/**
 * `/api/v1/orgs/:orgId/achievements`: what the org can award (OB `Achievement`s). Every saved
 * change becomes a new revision; credentials keep the revision they were issued with (design
 * plan §5.2). Drafts can't be awarded and aren't public; archived achievements can't be awarded
 * but their pages stay up, since issued credentials link to them.
 */
export const achievementRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const { db, config, storage } = services;
  acceptImageUploads(app);

  async function present(orgId: string, rows: AchievementRow[]): Promise<Achievement[]> {
    const files = await loadFiles(
      db,
      rows.map((row) => row.imageFileId),
    );
    const counts = await awardedCounts(
      db,
      orgId,
      rows.map((row) => row.id),
    );
    return rows.map((row) =>
      serializeAchievement(config.publicBaseUrl, row, files, counts.get(row.id) ?? 0),
    );
  }

  async function load(orgId: string, achievementId: string, tx: Queryable = db, lock = false) {
    const query = tx
      .select()
      .from(achievement)
      .where(and(eq(achievement.orgId, orgId), eq(achievement.id, achievementId)));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw notFound('Achievement');
    return row;
  }

  async function presentOne(orgId: string, achievementId: string) {
    const [result] = await present(orgId, [await load(orgId, achievementId)]);
    if (!result) throw notFound('Achievement');
    return result;
  }

  /**
   * Applies a change to an achievement in one transaction: a new revision when any signed field
   * changed, and the audit event.
   */
  async function saveChange(
    request: FastifyRequest,
    access: OrgAccess,
    achievementId: string,
    change: (before: AchievementRow) => Partial<AchievementSnapshot>,
    action = 'achievement.updated',
  ) {
    return db.transaction(async (tx) => {
      const before = await load(access.org.id, achievementId, tx, true);
      const next: AchievementSnapshot = { ...snapshotOf(before), ...change(before) };
      if (!next.criteriaNarrative && !next.criteriaUrl) {
        throw new ApiError(400, 'validation_failed', 'Check the highlighted fields', undefined, {
          criteriaNarrative: 'Describe how it is earned, or link to a page that does',
        });
      }
      const fields = changedFields(snapshotOf(before), next);
      if (fields.length === 0) return before;
      const revision = before.revision + 1;
      const [after] = await tx
        .update(achievement)
        .set({ ...next, revision, updatedAt: new Date() })
        .where(eq(achievement.id, achievementId))
        .returning();
      if (!after) throw notFound('Achievement');
      await tx.insert(achievementRevision).values({
        achievementId,
        revision,
        orgId: access.org.id,
        data: next,
        createdBy: access.actor.user.id,
      });
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: userActor(access.actor),
        action,
        target: { type: 'achievement', id: achievementId },
        data: { revision, fields },
        request: requestInfo(request),
      });
      return after;
    });
  }

  app.get('/achievements', async (request): Promise<{ achievements: Achievement[] }> => {
    const access = requirePermission(request, 'achievement:read');
    const { status } = parse(achievementsQuery, request.query);
    const rows = await db
      .select()
      .from(achievement)
      .where(
        and(
          eq(achievement.orgId, access.org.id),
          status ? eq(achievement.status, status) : undefined,
        ),
      )
      .orderBy(desc(achievement.updatedAt))
      .limit(500);
    return { achievements: await present(access.org.id, rows) };
  });

  /** Creates a draft. It belongs to the org's issuer (the issuer app shows one per org). */
  app.post('/achievements', async (request, reply) => {
    const access = requirePermission(request, 'achievement:write');
    requireWritable(access);
    const input = parse(achievementInput, request.body);
    const [owner] = await db
      .select({ id: issuer.id })
      .from(issuer)
      .where(eq(issuer.orgId, access.org.id))
      .orderBy(asc(issuer.createdAt))
      .limit(1);
    if (!owner) {
      throw new ApiError(
        409,
        'issuer_not_ready',
        'Set up your issuer profile first',
        'Achievements are awarded in the name of your issuer profile.',
      );
    }

    const created = await db.transaction(async (tx) => {
      const snapshot: AchievementSnapshot = {
        name: input.name,
        description: input.description,
        criteriaNarrative: input.criteriaNarrative ?? null,
        criteriaUrl: input.criteriaUrl ?? null,
        achievementType: input.achievementType ?? 'Badge',
        imageFileId: null,
        tags: input.tags ?? [],
        alignments: (input.alignments ?? []).map(cleanAlignment),
        validForDays: input.validForDays ?? null,
      };
      const [row] = await tx
        .insert(achievement)
        .values({
          ...snapshot,
          orgId: access.org.id,
          issuerId: owner.id,
          revision: 1,
          status: 'draft',
          createdBy: access.actor.user.id,
        })
        .returning();
      if (!row) throw new Error('Insert returned no row.');
      await tx.insert(achievementRevision).values({
        achievementId: row.id,
        revision: 1,
        orgId: access.org.id,
        data: snapshot,
        createdBy: access.actor.user.id,
      });
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: userActor(access.actor),
        action: 'achievement.created',
        target: { type: 'achievement', id: row.id },
        data: { name: row.name, achievementType: row.achievementType },
        request: requestInfo(request),
      });
      return row;
    });
    return reply.code(201).send(await presentOne(access.org.id, created.id));
  });

  app.get('/achievements/:achievementId', async (request) => {
    const access = requirePermission(request, 'achievement:read');
    return presentOne(access.org.id, idOf(request));
  });

  app.patch('/achievements/:achievementId', async (request) => {
    const access = requirePermission(request, 'achievement:write');
    requireWritable(access);
    const achievementId = idOf(request);
    const input = parse(updateAchievementInput, request.body);
    await saveChange(request, access, achievementId, () => ({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.criteriaNarrative !== undefined && { criteriaNarrative: input.criteriaNarrative }),
      ...(input.criteriaUrl !== undefined && { criteriaUrl: input.criteriaUrl }),
      ...(input.achievementType !== undefined && { achievementType: input.achievementType }),
      ...(input.tags !== undefined && { tags: input.tags }),
      ...(input.alignments !== undefined && { alignments: input.alignments.map(cleanAlignment) }),
      ...(input.validForDays !== undefined && { validForDays: input.validForDays }),
    }));
    return presentOne(access.org.id, achievementId);
  });

  /** Sets the badge image: the file itself as the body (PNG, SVG, JPEG or WebP, up to 2 MB). */
  app.put('/achievements/:achievementId/image', UPLOAD_ROUTE_OPTIONS, async (request) => {
    const access = requirePermission(request, 'achievement:write');
    requireWritable(access);
    const achievementId = idOf(request);
    await load(access.org.id, achievementId);
    const image = await storeUploadedImage(db, storage, request, {
      orgId: access.org.id,
      kind: 'badge_image',
      subjectId: achievementId,
      createdBy: access.actor.user.id,
    });
    await saveChange(
      request,
      access,
      achievementId,
      () => ({ imageFileId: image.id }),
      'achievement.image_changed',
    );
    return presentOne(access.org.id, achievementId);
  });

  /** Makes a draft awardable (and its page public). Needs an image and a working signing key. */
  app.post('/achievements/:achievementId/publish', async (request) => {
    const access = requirePermission(request, 'achievement:write');
    requireWritable(access);
    const achievementId = idOf(request);
    await db.transaction(async (tx) => {
      const row = await load(access.org.id, achievementId, tx, true);
      if (row.status === 'active') return;
      if (row.status !== 'draft')
        throw conflict('Only drafts can be published. Restore it instead.');
      if (!row.imageFileId) {
        throw new ApiError(400, 'validation_failed', 'Add a badge image first', undefined, {
          image: 'Add a badge image before publishing',
        });
      }
      const [key] = await tx
        .select({ id: signingKey.id })
        .from(signingKey)
        .where(and(eq(signingKey.issuerId, row.issuerId), eq(signingKey.status, 'active')));
      if (!key) {
        throw new ApiError(
          409,
          'issuer_not_ready',
          'The issuer has no active signing key',
          'Badges can’t be signed until the issuer has an active key.',
        );
      }
      await tx
        .update(achievement)
        .set({ status: 'active', publishedAt: new Date(), updatedAt: new Date() })
        .where(eq(achievement.id, achievementId));
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: userActor(access.actor),
        action: 'achievement.published',
        target: { type: 'achievement', id: achievementId },
        data: { revision: row.revision },
        request: requestInfo(request),
      });
    });
    return presentOne(access.org.id, achievementId);
  });

  /** Stops new awards. Issued credentials and the public page are unaffected. */
  app.post('/achievements/:achievementId/archive', async (request) => {
    const access = requirePermission(request, 'achievement:write');
    requireWritable(access);
    const achievementId = idOf(request);
    await db.transaction(async (tx) => {
      const row = await load(access.org.id, achievementId, tx, true);
      if (row.status === 'archived') return;
      if (row.status !== 'active') {
        throw conflict('Only published achievements can be archived. Delete a draft instead.');
      }
      await tx
        .update(achievement)
        .set({ status: 'archived', archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(achievement.id, achievementId));
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: userActor(access.actor),
        action: 'achievement.archived',
        target: { type: 'achievement', id: achievementId },
        request: requestInfo(request),
      });
    });
    return presentOne(access.org.id, achievementId);
  });

  app.post('/achievements/:achievementId/restore', async (request) => {
    const access = requirePermission(request, 'achievement:write');
    requireWritable(access);
    const achievementId = idOf(request);
    await db.transaction(async (tx) => {
      const row = await load(access.org.id, achievementId, tx, true);
      if (row.status === 'active') return;
      if (row.status !== 'archived') throw conflict('Only archived achievements can be restored.');
      await tx
        .update(achievement)
        .set({ status: 'active', archivedAt: null, updatedAt: new Date() })
        .where(eq(achievement.id, achievementId));
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: userActor(access.actor),
        action: 'achievement.restored',
        target: { type: 'achievement', id: achievementId },
        request: requestInfo(request),
      });
    });
    return presentOne(access.org.id, achievementId);
  });

  /** Deletes a draft (never awarded) and its images. Published achievements are archived instead. */
  app.delete('/achievements/:achievementId', async (request, reply) => {
    const access = requirePermission(request, 'achievement:write');
    requireWritable(access);
    const achievementId = idOf(request);
    const images = await db.transaction(async (tx) => {
      const row = await load(access.org.id, achievementId, tx, true);
      if (row.status !== 'draft') {
        throw conflict('Only drafts can be deleted. Archive a published achievement instead.');
      }
      await tx.delete(achievement).where(eq(achievement.id, achievementId));
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: userActor(access.actor),
        action: 'achievement.deleted',
        target: { type: 'achievement', id: achievementId },
        data: { name: row.name },
        request: requestInfo(request),
      });
      return tx
        .select()
        .from(file)
        .where(
          and(
            eq(file.orgId, access.org.id),
            eq(file.kind, 'badge_image'),
            eq(file.subjectId, achievementId),
          ),
        );
    });
    await deleteFiles(db, storage, images);
    return reply.code(204).send();
  });

  app.get(
    '/achievements/:achievementId/revisions',
    async (request): Promise<{ revisions: AchievementRevision[] }> => {
      const access = requirePermission(request, 'achievement:read');
      const achievementId = idOf(request);
      await load(access.org.id, achievementId);
      const rows = await db
        .select({
          revision: achievementRevision.revision,
          createdAt: achievementRevision.createdAt,
          userId: user.id,
          userName: user.name,
        })
        .from(achievementRevision)
        .leftJoin(user, eq(achievementRevision.createdBy, user.id))
        .where(
          and(
            eq(achievementRevision.orgId, access.org.id),
            eq(achievementRevision.achievementId, achievementId),
          ),
        )
        .orderBy(desc(achievementRevision.revision))
        .limit(200);
      return {
        revisions: rows.map((row) => ({
          revision: row.revision,
          createdAt: row.createdAt.toISOString(),
          createdBy: row.userId ? { id: row.userId, name: row.userName ?? '' } : null,
        })),
      };
    },
  );
};

function cleanAlignment(input: {
  targetName: string;
  targetUrl: string;
  targetDescription?: string | null;
  targetFramework?: string | null;
  targetCode?: string | null;
  targetType?: string | null;
}) {
  return {
    targetName: input.targetName,
    targetUrl: input.targetUrl,
    ...(input.targetDescription && { targetDescription: input.targetDescription }),
    ...(input.targetFramework && { targetFramework: input.targetFramework }),
    ...(input.targetCode && { targetCode: input.targetCode }),
    ...(input.targetType && { targetType: input.targetType }),
  };
}
