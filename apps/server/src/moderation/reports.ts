import { createHmac, timingSafeEqual } from 'node:crypto';
import { REPORT_CATEGORY_LABELS, type ReportCategory } from '@credforge/contracts';
import {
  achievement,
  and,
  contentReport,
  credential,
  eq,
  file,
  issuer,
  type Queryable,
} from '@credforge/db';
import { achievementUrl } from '../achievements/service';
import type { RateLimiter } from '../api/rate-limit';
import { recordAudit } from '../audit/audit';
import { credentialUrl } from '../credentials/service';
import { reportReceivedMessage } from '../email/messages';
import { parseImageName } from '../files/service';
import { issuerUrl } from '../issuers/service';
import { platformAdminEmails } from '../orgs/service';
import type { Services } from '../services';
import { achievementText, issuerText } from './content';
import { holdItems, imageItems, publicImage, publicText } from './service';

/**
 * Reports from the "Report a problem" form on public badge, achievement and issuer pages (design
 * plan §6.5). They are stored for the moderation queue and emailed to the platform admins. A
 * child-safety report holds the page's images at once, until a platform admin looks.
 *
 * Abuse protection without a third-party CAPTCHA: a rate limit per client IP, a signed form token
 * (the form must have been loaded from this site at least a few seconds and at most a day
 * earlier), a field people never see (bots fill it in), and the same-origin check.
 */

export type ReportTargetType = 'credential' | 'achievement' | 'issuer';

export interface ReportTarget {
  type: ReportTargetType;
  id: string;
  orgId: string;
  /** How the page is named on the report form: what the public page shows. */
  name: string;
  pageUrl: string;
  /** The images the page shows (badge image, issuer logo). */
  imageFileIds: string[];
}

export const REPORT_DETAILS_MAX = 2000;
/** People take longer than this to choose a category; scripts don't. */
export const REPORT_FORM_MIN_AGE_MS = 3_000;
export const REPORT_FORM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function mac(secret: string, target: { type: string; id: string }, issued: string): string {
  return createHmac('sha256', secret)
    .update(`credforge-report-form:${target.type}:${target.id}:${issued}`)
    .digest('base64url')
    .slice(0, 32);
}

/** A token for the form on a page: when it was made, signed for that page. */
export function reportFormToken(
  secret: string,
  target: { type: string; id: string },
  now = Date.now(),
): string {
  const issued = now.toString(36);
  return `${issued}.${mac(secret, target, issued)}`;
}

export function checkReportFormToken(
  secret: string,
  target: { type: string; id: string },
  token: string | undefined,
  now = Date.now(),
): 'ok' | 'too_fast' | 'invalid' {
  const [issued, signature] = (token ?? '').split('.');
  if (!issued || !signature || !/^[0-9a-z]{1,12}$/.test(issued)) return 'invalid';
  const expected = Buffer.from(mac(secret, target, issued));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  const age = now - Number.parseInt(issued, 36);
  if (age < 0 || age > REPORT_FORM_MAX_AGE_MS) return 'invalid';
  return age < REPORT_FORM_MIN_AGE_MS ? 'too_fast' : 'ok';
}

/** The file behind one of this instance's image URLs (an issuer logo in a credential). */
async function fileForImageUrl(db: Queryable, base: string, url: string | undefined) {
  const match = url?.startsWith(base)
    ? /^\/(achievements|issuers)\/([0-9a-f-]{36})\/images\/([^/]+)$/.exec(url.slice(base.length))
    : null;
  const parsed = match?.[3] ? parseImageName(match[3]) : null;
  if (!match || !parsed) return undefined;
  const [row] = await db
    .select({ id: file.id })
    .from(file)
    .where(
      and(
        eq(file.kind, match[1] === 'achievements' ? 'badge_image' : 'issuer_logo'),
        eq(file.subjectId, match[2] as string),
        eq(file.sha256, parsed.sha256),
      ),
    );
  return row?.id;
}

/** A page that can be reported: one the public can see. Null otherwise (the form answers 404). */
export async function reportTarget(
  db: Queryable,
  base: string,
  type: ReportTargetType,
  id: string,
): Promise<ReportTarget | null> {
  if (type === 'credential') {
    const [row] = await db.select().from(credential).where(eq(credential.id, id));
    if (!row?.document || row.visibility !== 'public' || row.heldItemIds.length > 0) return null;
    const subject = row.document.credentialSubject as { achievement?: { name?: unknown } };
    const issuerDoc = row.document.issuer as { image?: { id?: unknown } } | undefined;
    const name = typeof subject?.achievement?.name === 'string' ? subject.achievement.name : null;
    const logo = await fileForImageUrl(
      db,
      base,
      typeof issuerDoc?.image?.id === 'string' ? issuerDoc.image.id : undefined,
    );
    return {
      type,
      id,
      orgId: row.orgId,
      name: name ? `the ${name} badge` : 'a badge',
      pageUrl: credentialUrl(base, id),
      imageFileIds: [row.imageFileId, logo].filter((value): value is string => Boolean(value)),
    };
  }
  if (type === 'achievement') {
    const [row] = await db.select().from(achievement).where(eq(achievement.id, id));
    if (!row || row.status === 'draft' || row.removedAt) return null;
    const shown = await publicText(
      db,
      { type: 'achievement', id, itemId: row.textItemId },
      achievementText(row),
    );
    const image = await publicImage(db, { type: 'achievement', id, fileId: row.imageFileId });
    return {
      type,
      id,
      orgId: row.orgId,
      name: shown.text ? `the achievement ${shown.text.name}` : 'an achievement',
      pageUrl: achievementUrl(base, id),
      imageFileIds: image ? [image.id] : [],
    };
  }
  const [row] = await db.select().from(issuer).where(eq(issuer.id, id));
  if (!row) return null;
  const shown = await publicText(
    db,
    { type: 'issuer', id, itemId: row.textItemId },
    issuerText(row),
  );
  const logo = await publicImage(db, { type: 'issuer', id, fileId: row.imageFileId });
  return {
    type,
    id,
    orgId: row.orgId,
    name: shown.text ? `the issuer ${shown.text.name}` : 'an issuer',
    pageUrl: issuerUrl(base, id),
    imageFileIds: logo ? [logo.id] : [],
  };
}

export interface ReportInput {
  category: ReportCategory;
  details: string | null;
  reporterEmail: string | null;
}

/**
 * Stores a report and, for child safety, holds the page's images in the same transaction. Then
 * emails the platform admins (a child-safety report always; others while `mailLimiter` allows, so
 * a flood of reports can't flood their inboxes: they are all in the queue anyway).
 */
export async function createReport(
  services: Pick<Services, 'db' | 'config' | 'outbox'>,
  target: ReportTarget,
  input: ReportInput,
  mailLimiter: RateLimiter,
): Promise<{ id: string; heldItemIds: string[] }> {
  const { db, config, outbox } = services;
  const report = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(contentReport)
      .values({
        orgId: target.orgId,
        targetType: target.type,
        targetId: target.id,
        category: input.category,
        details: input.details,
        reporterEmail: input.reporterEmail,
      })
      .returning({ id: contentReport.id });
    if (!row) throw new Error('Insert returned no row.');
    let heldItemIds: string[] = [];
    if (input.category === 'child_safety') {
      const items = await imageItems(tx, target.imageFileIds);
      heldItemIds = await holdItems(
        tx,
        [...items.values()].map((item) => item.id),
        {
          source: 'report',
          at: new Date().toISOString(),
          reportId: row.id,
          category: input.category,
        },
      );
      if (heldItemIds.length > 0) {
        await tx.update(contentReport).set({ heldItemIds }).where(eq(contentReport.id, row.id));
        // In the org's log, without anything about the report or who sent it.
        await recordAudit(tx, {
          orgId: target.orgId,
          actor: { type: 'system', label: 'report' },
          action: 'moderation.images_held',
          target: { type: target.type, id: target.id },
          data: { items: heldItemIds },
        });
      }
    }
    return { id: row.id, heldItemIds };
  });

  if (input.category === 'child_safety' || mailLimiter.take('report-mail').allowed) {
    for (const to of await platformAdminEmails(db)) {
      await outbox.send(
        reportReceivedMessage({
          to,
          category: REPORT_CATEGORY_LABELS[input.category],
          pageUrl: target.pageUrl,
          details: input.details,
          imagesHeld: report.heldItemIds.length > 0,
          queueUrl: `${config.publicBaseUrl}/app/platform/moderation`,
        }),
      );
    }
  }
  return report;
}
