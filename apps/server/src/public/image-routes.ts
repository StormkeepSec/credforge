import { and, eq, file } from '@credforge/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { isUuid } from '../api/errors';
import { type ImageFileKind, parseImageName } from '../files/service';
import { placeholderPng, placeholderSvg } from '../moderation/placeholders';
import { imageItems, statusOf } from '../moderation/service';
import { isOrgMember } from '../moderation/viewer';
import type { Services } from '../services';

/**
 * Served images are files people uploaded, so they get a CSP of their own that blocks scripts and
 * everything else even if an SVG is opened directly (the sanitizer already removed them).
 */
export const UPLOAD_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * How long browsers and nginx keep a cleared image. The bytes behind a URL never change, but a
 * platform admin can remove an image (design plan §6.5, decision 57): it then disappears from
 * every cache within this time.
 */
export const IMAGE_CACHE = 'public, max-age=600';

/**
 * Badge images and issuer logos at their permanent, content-addressed URLs (design plan §5.4,
 * §13.5): `/achievements/{id}/images/{sha256}.png|svg`, `…-512.png`, `…-128.png`, `…-og.png`, and
 * the same under `/issuers/{id}/images/`. Storage stays private; the app streams the object.
 *
 * Only cleared images are served (§6.5). One waiting for review answers with a neutral
 * placeholder, except to the org's own members (their issuer app shows it); a removed one answers
 * with an "Image removed" placeholder for good, so badges that refer to it still verify.
 */
export const publicImageRoutes: FastifyPluginAsync<{
  services: Pick<Services, 'db' | 'storage' | 'auth' | 'config'>;
}> = async (app, { services }) => {
  const { db, storage } = services;

  const serve = (kind: ImageFileKind) => async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, name } = request.params as { id: string; name: string };
    const parsed = parseImageName(name);
    if (!isUuid(id) || !parsed) return reply.callNotFound();

    const [row] = await db
      .select()
      .from(file)
      .where(
        and(
          eq(file.kind, kind),
          eq(file.subjectId, id.toLowerCase()),
          eq(file.sha256, parsed.sha256),
        ),
      );
    if (!row) return reply.callNotFound();
    const isSvg = row.mimeType === 'image/svg+xml';
    const key = parsed.variant
      ? row.variants[parsed.variant]?.key
      : parsed.extension === (isSvg ? 'svg' : 'png')
        ? row.key
        : undefined;
    if (!key) return reply.callNotFound();

    reply
      .header('content-security-policy', UPLOAD_CSP)
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('access-control-allow-origin', '*');

    const status = statusOf((await imageItems(db, [row.id])).get(row.id));
    const member = status === 'pending' && (await isOrgMember(services, request, reply, row.orgId));
    if (status !== 'cleared' && !member) {
      const placeholder = status === 'removed' ? 'removed' : 'held';
      // A held image may be cleared any minute: never cache its placeholder.
      reply.header('cache-control', placeholder === 'held' ? 'no-store' : 'public, max-age=300');
      if (placeholder === 'held') reply.header('vary', 'Cookie');
      if (parsed.extension === 'svg')
        return reply.type('image/svg+xml').send(placeholderSvg(placeholder));
      return reply
        .type('image/png')
        .send(await placeholderPng(placeholder, parsed.variant ?? '512'));
    }

    if (member) {
      // The org's own held image: for its members only.
      reply.header('cache-control', 'private, no-store').header('vary', 'Cookie');
    } else {
      const etag = `"${parsed.sha256.slice(0, 32)}${parsed.variant ? `-${parsed.variant}` : ''}"`;
      reply.header('cache-control', IMAGE_CACHE).header('etag', etag);
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    }

    const bytes = await storage.get(key);
    if (!bytes) {
      request.log.error({ fileId: row.id, key }, 'stored image object is missing');
      return reply.callNotFound();
    }
    return reply.type(parsed.variant || !isSvg ? 'image/png' : 'image/svg+xml').send(bytes);
  };

  app.get('/achievements/:id/images/:name', serve('badge_image'));
  app.get('/issuers/:id/images/:name', serve('issuer_logo'));
};
