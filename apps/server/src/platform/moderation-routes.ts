import {
  type ContentReport,
  type ContentReportPage,
  disableUserInput,
  type ModerationItemPage,
  type ModerationSummary,
  moderationClearInput,
  moderationItemsQuery,
  moderationReasonInput,
  reportsQuery,
  resolveReportInput,
} from '@credforge/contracts';
import {
  achievement,
  and,
  contentReport,
  desc,
  eq,
  file,
  inArray,
  issuer,
  lt,
  moderationItem,
  or,
  organization,
  session,
  sql,
  user,
} from '@credforge/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { ApiError, forbidden, notFound, parse, uuidParam } from '../api/errors';
import { recordAudit } from '../audit/audit';
import {
  accountDisabledMessage,
  accountEnabledMessage,
  achievementReinstatedMessage,
  achievementUnpublishedMessage,
  contentClearedMessage,
  contentRemovedMessage,
  memberDisabledMessage,
} from '../email/messages';
import type { EmailMessage } from '../email/transport';
import { describeItem, IN_QUEUE, listItems, serializeItems } from '../moderation/queue';
import { reportTarget } from '../moderation/reports';
import { recheck } from '../moderation/scan';
import {
  decideItems,
  imageItems,
  imageWithheld,
  isHashMatched,
  type ModerationItemRow,
} from '../moderation/service';
import { requestInfo, userActor } from '../orgs/access';
import { ownerEmails } from '../orgs/service';
import { UPLOAD_CSP } from '../public/image-routes';
import type { Services } from '../services';
import { requirePlatformAdmin } from './admin';

const imageQuery = z.object({ view: z.enum(['blurred', 'full']).default('blurred') });

/** Known CSAM is never shown or published again (decision 61). */
function withheldError() {
  return new ApiError(
    403,
    'forbidden',
    'This image is never shown',
    'It matches known child sexual abuse material. It was blocked and is kept only as sealed evidence: see the abuse-handling runbook.',
  );
}

function refuseWithheld(row: ModerationItemRow, hashMatching: boolean) {
  const withheld = imageWithheld(row, hashMatching);
  if (withheld === 'known_csam') throw withheldError();
  if (withheld === 'awaiting_check') {
    throw new ApiError(
      409,
      'conflict',
      'Not checked yet',
      'This image is shown once the check against known child sexual abuse material has passed.',
    );
  }
}

/** Nothing is cleared before its automatic check has run, and known CSAM never is. */
function refuseUnchecked(row: ModerationItemRow) {
  if (isHashMatched(row)) throw withheldError();
  if (row.scanStatus === 'waiting') {
    throw new ApiError(
      409,
      'conflict',
      'The automatic check hasn’t run yet',
      'Try again in a moment: content is cleared only after its automatic check.',
    );
  }
}

/**
 * `/api/v1/platform`: the moderation queue (design plan §6.5). Platform admins review held images
 * (blurred until they choose to see them, and never offered as a download) and text, and reports
 * from public pages; clear or remove content, unpublish achievements, and disable accounts. Every
 * action writes an audit event and emails the org's owners the reason. Suspending an org and
 * revoking its badges are in platform/routes.ts.
 */
export const moderationRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const { db, config, outbox, storage } = services;
  const base = config.publicBaseUrl;
  const appeal = { abuseEmail: config.abuseEmail };
  const hashMatching = config.moderation.csamMatcher.kind !== 'none';
  const scanView = { hashMatching };
  const admin = (request: FastifyRequest, reply: FastifyReply) =>
    requirePlatformAdmin(services, request, reply);

  async function loadItem(itemId: string) {
    const [row] = await db.select().from(moderationItem).where(eq(moderationItem.id, itemId));
    if (!row) throw notFound('Item');
    return row;
  }

  async function present(row: ModerationItemRow) {
    const [item] = await serializeItems(db, base, [row], scanView);
    if (!item) throw notFound('Item');
    return item;
  }

  async function notifyOwners(orgId: string, message: (to: string) => EmailMessage) {
    for (const to of await ownerEmails(db, orgId)) await outbox.send(message(to));
  }

  app.get('/moderation/summary', async (request, reply): Promise<ModerationSummary> => {
    await admin(request, reply);
    const [items] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(moderationItem)
      .where(and(eq(moderationItem.status, 'pending'), IN_QUEUE));
    const [reports] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contentReport)
      .where(eq(contentReport.status, 'open'));
    const [scans] = await db
      .select({
        waiting: sql<number>`count(*) filter (where ${moderationItem.scanStatus} = 'waiting')::int`,
        failed: sql<number>`count(*) filter (where ${moderationItem.scanStatus} = 'failed' and ${moderationItem.status} = 'pending')::int`,
      })
      .from(moderationItem)
      .where(sql`${moderationItem.scanStatus} in ('waiting', 'failed')`);
    const { scanner, csamMatcher } = config.moderation;
    return {
      pendingItems: items?.count ?? 0,
      openReports: reports?.count ?? 0,
      scanning: {
        provider: scanner.provider === 'none' ? null : scanner.name,
        images: scanner.provider !== 'none' && scanner.images,
        text: scanner.provider !== 'none' && scanner.text,
        csamMatcher: csamMatcher.kind === 'none' ? null : csamMatcher.name,
        waiting: scans?.waiting ?? 0,
        failed: scans?.failed ?? 0,
      },
    };
  });

  app.get('/moderation/items', async (request, reply): Promise<ModerationItemPage> => {
    await admin(request, reply);
    const query = parse(moderationItemsQuery, request.query);
    const { rows, next } = await listItems(db, query);
    return { items: await serializeItems(db, base, rows, scanView), next };
  });

  /**
   * An image item, for a platform admin's eyes only: the 512 px PNG (never the original, so no
   * SVG runs here), blurred beyond recognition unless `view=full`. No-store and inline, never an
   * attachment. Never an image that matched known CSAM (decision 61), nor one the known-CSAM
   * matcher hasn't checked yet.
   */
  app.get('/moderation/items/:itemId/image', async (request, reply) => {
    await admin(request, reply);
    const row = await loadItem(uuidParam((request.params as { itemId?: string }).itemId, 'Item'));
    if (row.kind !== 'image' || !row.fileId) throw notFound('Image');
    refuseWithheld(row, hashMatching);
    const [stored] = await db.select().from(file).where(eq(file.id, row.fileId));
    const key = stored?.variants['512']?.key;
    const bytes = key ? await storage.get(key) : null;
    if (!bytes) throw notFound('Image');
    const { view } = parse(imageQuery, request.query);
    const body =
      view === 'full'
        ? bytes
        : await sharp(bytes)
            .resize(24, 24, { fit: 'inside' })
            .resize(256, 256, { fit: 'inside', kernel: 'cubic' })
            .blur(12)
            .png()
            .toBuffer();
    return reply
      .header('content-security-policy', UPLOAD_CSP)
      .header('content-disposition', 'inline')
      .header('cross-origin-resource-policy', 'same-origin')
      .type('image/png')
      .send(body);
  });

  app.post('/moderation/items/:itemId/clear', async (request, reply) => {
    const actor = await admin(request, reply);
    const itemId = uuidParam((request.params as { itemId?: string }).itemId, 'Item');
    const { note } = parse(moderationClearInput, request.body);
    const row = await loadItem(itemId);
    const [changed] = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(moderationItem)
        .where(eq(moderationItem.id, itemId))
        .for('update');
      if (current) refuseUnchecked(current);
      const rows = await decideItems(tx, [itemId], 'cleared', {
        userId: actor.user.id,
        note: note ?? null,
      });
      for (const item of rows) {
        await recordAudit(tx, {
          orgId: item.orgId,
          actor: userActor(actor),
          action: 'moderation.cleared',
          target: { type: 'moderation_item', id: item.id },
          data: {
            kind: item.kind,
            subject: { type: item.subjectType, id: item.subjectId },
            from: row.status,
            note: note ?? null,
          },
          request: requestInfo(request),
        });
      }
      return rows;
    });
    const item = await present(changed ?? row);
    if (changed) {
      const what = describeItem(changed, item.subject.name);
      await notifyOwners(changed.orgId, (to) =>
        contentClearedMessage(to, item.org.name, [what], `${base}/app`),
      );
    }
    return item;
  });

  app.post('/moderation/items/:itemId/remove', async (request, reply) => {
    const actor = await admin(request, reply);
    const itemId = uuidParam((request.params as { itemId?: string }).itemId, 'Item');
    const { reason } = parse(moderationReasonInput, request.body);
    const row = await loadItem(itemId);
    const [changed] = await db.transaction(async (tx) => {
      const rows = await decideItems(tx, [itemId], 'removed', {
        userId: actor.user.id,
        note: reason,
      });
      for (const item of rows) {
        await recordAudit(tx, {
          orgId: item.orgId,
          actor: userActor(actor),
          action: 'moderation.removed',
          target: { type: 'moderation_item', id: item.id },
          data: {
            kind: item.kind,
            subject: { type: item.subjectType, id: item.subjectId },
            from: row.status,
            reason,
          },
          request: requestInfo(request),
        });
      }
      return rows;
    });
    const item = await present(changed ?? row);
    if (changed) {
      const what = describeItem(changed, item.subject.name);
      await notifyOwners(changed.orgId, (to) =>
        contentRemovedMessage(to, item.org.name, what, reason, appeal),
      );
    }
    return item;
  });

  /**
   * Checks an item again (one whose check gave up, or after the scanner was fixed): it waits for
   * its check, and the queue shows it again once the check has run.
   */
  app.post('/moderation/items/:itemId/recheck', async (request, reply) => {
    const actor = await admin(request, reply);
    const itemId = uuidParam((request.params as { itemId?: string }).itemId, 'Item');
    const row = await loadItem(itemId);
    const { scan } = config.moderation;
    if (!(row.kind === 'image' ? scan.images : scan.text)) {
      throw new ApiError(
        409,
        'conflict',
        'No automatic check is set up',
        'Set up a scanner first.',
      );
    }
    if (isHashMatched(row)) throw withheldError();
    if (row.status !== 'pending' || row.scanStatus === 'waiting') {
      throw new ApiError(
        409,
        'conflict',
        'Not possible in this state',
        row.scanStatus === 'waiting'
          ? 'Its check is already waiting to run.'
          : 'Only items waiting for review can be checked again.',
      );
    }
    await recheck({ db, jobs: services.jobs }, row);
    await recordAudit(db, {
      orgId: row.orgId,
      actor: userActor(actor),
      action: 'moderation.recheck_requested',
      target: { type: 'moderation_item', id: row.id },
      data: { kind: row.kind, from: row.scanStatus },
      request: requestInfo(request),
    });
    return present(await loadItem(itemId));
  });

  async function loadAchievement(request: FastifyRequest) {
    const achievementId = uuidParam(
      (request.params as { achievementId?: string }).achievementId,
      'Achievement',
    );
    const [row] = await db
      .select({ achievement, orgName: organization.name })
      .from(achievement)
      .innerJoin(organization, eq(achievement.orgId, organization.id))
      .where(eq(achievement.id, achievementId));
    if (!row || row.achievement.status === 'draft') throw notFound('Achievement');
    return row;
  }

  /**
   * Unpublishes an achievement: it is archived (no more awards), its page answers 410, and its
   * badges' pages no longer show its details. Only a platform admin can put it back.
   */
  app.post('/achievements/:achievementId/unpublish', async (request, reply) => {
    const actor = await admin(request, reply);
    const { reason } = parse(moderationReasonInput, request.body);
    const { achievement: row, orgName } = await loadAchievement(request);
    const now = new Date();
    const changed = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(achievement)
        .set({
          status: 'archived',
          archivedAt: row.archivedAt ?? now,
          removedAt: now,
          removedBy: actor.user.id,
          removedReason: reason,
          updatedAt: now,
        })
        .where(and(eq(achievement.id, row.id), sql`${achievement.removedAt} is null`))
        .returning({ id: achievement.id });
      if (!updated) return false;
      await recordAudit(tx, {
        orgId: row.orgId,
        actor: userActor(actor),
        action: 'achievement.unpublished_by_platform',
        target: { type: 'achievement', id: row.id },
        data: { name: row.name, from: row.status, reason },
        request: requestInfo(request),
      });
      return true;
    });
    if (changed) {
      await notifyOwners(row.orgId, (to) =>
        achievementUnpublishedMessage(to, orgName, row.name, reason, appeal),
      );
    }
    return { id: row.id, removedAt: (row.removedAt ?? now).toISOString() };
  });

  /** Puts an unpublished achievement back, archived: the org restores it to award it again. */
  app.post('/achievements/:achievementId/reinstate', async (request, reply) => {
    const actor = await admin(request, reply);
    const { achievement: row, orgName } = await loadAchievement(request);
    const changed = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(achievement)
        .set({ removedAt: null, removedBy: null, removedReason: null, updatedAt: new Date() })
        .where(and(eq(achievement.id, row.id), sql`${achievement.removedAt} is not null`))
        .returning({ id: achievement.id });
      if (!updated) return false;
      await recordAudit(tx, {
        orgId: row.orgId,
        actor: userActor(actor),
        action: 'achievement.reinstated_by_platform',
        target: { type: 'achievement', id: row.id },
        data: { name: row.name },
        request: requestInfo(request),
      });
      return true;
    });
    if (changed) {
      await notifyOwners(row.orgId, (to) =>
        achievementReinstatedMessage(to, orgName, row.name, `${base}/app`),
      );
    }
    return { id: row.id, removedAt: null };
  });

  async function loadUser(request: FastifyRequest) {
    const userId = uuidParam((request.params as { userId?: string }).userId, 'User');
    const [row] = await db.select().from(user).where(eq(user.id, userId));
    if (!row) throw notFound('User');
    return row;
  }

  /**
   * Disables an account: its sessions end and it can't sign in until it is enabled again. Not a
   * platform admin's (remove their rights first) and not one's own.
   */
  app.post('/users/:userId/disable', async (request, reply) => {
    const actor = await admin(request, reply);
    const target = await loadUser(request);
    const input = parse(disableUserInput, request.body);
    if (target.id === actor.user.id) throw forbidden('You can’t disable your own account.');
    if (target.isPlatformAdmin) {
      throw forbidden('Take away this account’s platform admin rights first.');
    }
    const [org] = input.orgId
      ? await db
          .select({ id: organization.id, name: organization.name })
          .from(organization)
          .where(eq(organization.id, input.orgId))
      : [];
    if (input.orgId && !org) throw notFound('Organization');
    const now = new Date();
    const changed = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(user)
        .set({
          disabledAt: now,
          disabledReason: input.reason,
          disabledBy: actor.user.id,
          updatedAt: now,
        })
        .where(and(eq(user.id, target.id), sql`${user.disabledAt} is null`))
        .returning({ id: user.id });
      if (!updated) return false;
      const ended = await tx
        .delete(session)
        .where(eq(session.userId, target.id))
        .returning({ id: session.id });
      await recordAudit(tx, {
        orgId: input.orgId ?? null,
        actor: userActor(actor),
        action: 'user.disabled',
        target: { type: 'user', id: target.id },
        data: { email: target.email, reason: input.reason, sessionsEnded: ended.length },
        request: requestInfo(request),
      });
      return true;
    });
    if (changed) {
      await outbox.send(accountDisabledMessage(target.email, target.name, input.reason, appeal));
      if (org) {
        for (const to of await ownerEmails(db, org.id)) {
          if (to === target.email) continue;
          await outbox.send(
            memberDisabledMessage(to, org.name, target.email, input.reason, appeal),
          );
        }
      }
    }
    return { id: target.id, disabledAt: now.toISOString() };
  });

  app.post('/users/:userId/enable', async (request, reply) => {
    const actor = await admin(request, reply);
    const target = await loadUser(request);
    const changed = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(user)
        .set({ disabledAt: null, disabledReason: null, disabledBy: null, updatedAt: new Date() })
        .where(and(eq(user.id, target.id), sql`${user.disabledAt} is not null`))
        .returning({ id: user.id });
      if (!updated) return false;
      await recordAudit(tx, {
        orgId: null,
        actor: userActor(actor),
        action: 'user.enabled',
        target: { type: 'user', id: target.id },
        data: { email: target.email },
        request: requestInfo(request),
      });
      return true;
    });
    if (changed) {
      await outbox.send(accountEnabledMessage(target.email, target.name, `${base}/login`));
    }
    return { id: target.id, disabledAt: null };
  });

  // ---- reports ----

  async function presentReports(
    rows: (typeof contentReport.$inferSelect)[],
  ): Promise<ContentReport[]> {
    if (rows.length === 0) return [];
    const orgs = new Map(
      (
        await db
          .select({
            id: organization.id,
            name: organization.name,
            status: organization.status,
            trustedAt: organization.trustedAt,
          })
          .from(organization)
          .where(inArray(organization.id, [...new Set(rows.map((row) => row.orgId))]))
      ).map((row) => [row.id, row]),
    );
    const resolverIds = rows.map((row) => row.resolvedBy).filter((id): id is string => Boolean(id));
    const resolvers = new Map(
      resolverIds.length
        ? (
            await db
              .select({ id: user.id, name: user.name, email: user.email })
              .from(user)
              .where(inArray(user.id, resolverIds))
          ).map((row) => [row.id, row])
        : [],
    );
    const reports: ContentReport[] = [];
    for (const row of rows) {
      const target = await reportTarget(db, base, row.targetType, row.targetId);
      // What the page shows now (its images, its text), plus whatever this report held.
      const images = await imageItems(db, target?.imageFileIds ?? []);
      const ids = [
        ...new Set([
          ...[...images.values()].map((item) => item.id),
          ...(await textItemsFor(row)),
          ...row.heldItemIds,
        ]),
      ];
      const items = ids.length
        ? await db.select().from(moderationItem).where(inArray(moderationItem.id, ids))
        : [];
      const org = orgs.get(row.orgId);
      const resolver = row.resolvedBy ? resolvers.get(row.resolvedBy) : undefined;
      reports.push({
        id: row.id,
        status: row.status,
        category: row.category,
        details: row.details,
        reporterEmail: row.reporterEmail,
        createdAt: row.createdAt.toISOString(),
        target: {
          type: row.targetType,
          id: row.targetId,
          pageUrl: target?.pageUrl ?? `${base}/${row.targetType}s/${row.targetId}`,
          name: target?.name ?? 'a page that is no longer public',
        },
        org: {
          id: row.orgId,
          name: org?.name ?? '',
          status: org?.status ?? 'pending',
          trusted: Boolean(org?.trustedAt),
        },
        items: await serializeItems(db, base, items, scanView),
        heldItemIds: row.heldItemIds,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        resolvedBy: resolver ? { name: resolver.name, email: resolver.email } : null,
        resolutionNote: row.resolutionNote,
      });
    }
    return reports;
  }

  /** The current text items of the reported page's subject. */
  async function textItemsFor(row: typeof contentReport.$inferSelect): Promise<string[]> {
    if (row.targetType === 'issuer') {
      const [found] = await db
        .select({ id: issuer.textItemId })
        .from(issuer)
        .where(eq(issuer.id, row.targetId));
      return found?.id ? [found.id] : [];
    }
    const [found] =
      row.targetType === 'achievement'
        ? await db
            .select({ id: achievement.textItemId })
            .from(achievement)
            .where(eq(achievement.id, row.targetId))
        : await db
            .execute<{ id: string | null }>(
              sql`select a.text_item_id as id from credential c join achievement a on a.id = c.achievement_id where c.id = ${row.targetId}`,
            )
            .then((result) => result.rows);
    return found?.id ? [found.id] : [];
  }

  app.get('/reports', async (request, reply): Promise<ContentReportPage> => {
    await admin(request, reply);
    const query = parse(reportsQuery, request.query);
    const [at, id] = (query.before ?? '').split('_');
    const cursor =
      at && id && !Number.isNaN(new Date(at).getTime()) ? { at: new Date(at), id } : null;
    const rows = await db
      .select()
      .from(contentReport)
      .where(
        and(
          eq(contentReport.status, query.status),
          cursor
            ? or(
                lt(contentReport.createdAt, cursor.at),
                and(eq(contentReport.createdAt, cursor.at), lt(contentReport.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(contentReport.createdAt), desc(contentReport.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      reports: await presentReports(page),
      next: rows.length > query.limit && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
    };
  });

  app.post('/reports/:reportId/resolve', async (request, reply): Promise<ContentReport> => {
    const actor = await admin(request, reply);
    const reportId = uuidParam((request.params as { reportId?: string }).reportId, 'Report');
    const input = parse(resolveReportInput, request.body);
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(contentReport)
        .set({
          status: input.status,
          resolvedAt: new Date(),
          resolvedBy: actor.user.id,
          resolutionNote: input.note ?? null,
        })
        .where(and(eq(contentReport.id, reportId), eq(contentReport.status, 'open')))
        .returning();
      if (!updated) {
        const [current] = await tx
          .select()
          .from(contentReport)
          .where(eq(contentReport.id, reportId));
        if (!current) throw notFound('Report');
        throw new ApiError(409, 'conflict', 'Already decided', `The report is ${current.status}.`);
      }
      // In the instance's log, not the org's: reports and who sent them stay with the platform.
      await recordAudit(tx, {
        orgId: null,
        actor: userActor(actor),
        action: input.status === 'resolved' ? 'report.resolved' : 'report.dismissed',
        target: { type: 'content_report', id: reportId },
        data: { orgId: updated.orgId, category: updated.category, note: input.note ?? null },
        request: requestInfo(request),
      });
      return updated;
    });
    const [presented] = await presentReports([row]);
    if (!presented) throw notFound('Report');
    return presented;
  });
};
