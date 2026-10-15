import { and, eq, file } from '@credforge/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { isUuid } from '../api/errors';
import { type ImageFileKind, parseImageName } from '../files/service';
import type { Services } from '../services';

/**
 * Served images are files people uploaded, so they get a CSP of their own that blocks scripts and
 * everything else even if an SVG is opened directly (the sanitizer already removed them).
 */
export const UPLOAD_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * Badge images and issuer logos at their permanent, content-addressed URLs (design plan §5.4,
 * §13.5): `/achievements/{id}/images/{sha256}.png|svg`, `…-512.png`, `…-128.png`, `…-og.png`, and
 * the same under `/issuers/{id}/images/`. The bytes behind a URL never change, so responses are
 * cached for a year. Storage stays private; the app streams the object.
 */
export const publicImageRoutes: FastifyPluginAsync<{
  services: Pick<Services, 'db' | 'storage'>;
}> = async (app, { services: { db, storage } }) => {
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

    const etag = `"${parsed.sha256.slice(0, 32)}${parsed.variant ? `-${parsed.variant}` : ''}"`;
    reply
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('etag', etag)
      .header('content-security-policy', UPLOAD_CSP)
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('access-control-allow-origin', '*');
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();

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
