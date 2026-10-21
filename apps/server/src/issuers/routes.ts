import { type Issuer, issuerInput, updateIssuerInput } from '@credforge/contracts';
import { and, asc, eq, issuer } from '@credforge/db';
import type { FastifyPluginAsync } from 'fastify';
import { notFound, parse, uuidParam } from '../api/errors';
import type { RateLimiter } from '../api/rate-limit';
import { acceptImageUploads, storeUploadedImage, UPLOAD_ROUTE_OPTIONS } from '../api/uploads';
import { recordAudit } from '../audit/audit';
import { deleteFiles, loadFiles } from '../files/service';
import { loadReviews } from '../moderation/service';
import { reviewImage, reviewIssuerText } from '../moderation/subjects';
import { requestInfo, requirePermission, requireWritable } from '../orgs/access';
import type { Services } from '../services';
import { checkDomain, createDomainChecker, domainChanges, startDomainVerification } from './domain';
import {
  createSigningKey,
  type IssuerRow,
  keysForIssuers,
  loadSigner,
  serializeIssuer,
} from './service';

/** Fields that differ between the stored issuer and an update, as `{ field: { from, to } }`. */
function changes(before: IssuerRow, after: IssuerRow) {
  const diff: Record<string, { from: string | null; to: string | null }> = {};
  for (const field of ['name', 'url', 'email', 'description'] as const) {
    if (before[field] !== after[field]) diff[field] = { from: before[field], to: after[field] };
  }
  return diff;
}

/** `/api/v1/orgs/:orgId/issuers`: the org's issuer profiles (OB `Profile`s) and their keys. */
export const issuerRoutes: FastifyPluginAsync<{
  services: Services;
  /** Uploads per org (shared by every upload route). */
  uploadLimiter: RateLimiter;
}> = async (app, { services, uploadLimiter }) => {
  const { db, keys, config, storage } = services;
  const domains =
    services.domains ?? createDomainChecker(`credforge-domain-check (+${config.publicBaseUrl})`);
  acceptImageUploads(app);

  async function load(orgId: string, issuerId: string): Promise<Issuer> {
    const [row] = await db
      .select()
      .from(issuer)
      .where(and(eq(issuer.orgId, orgId), eq(issuer.id, issuerId)));
    if (!row) throw notFound('Issuer');
    return serializeIssuer(
      config.publicBaseUrl,
      row,
      await keysForIssuers(db, orgId, [row.id]),
      await loadFiles(db, [row.imageFileId]),
      await loadReviews(db, [row]),
    );
  }

  app.get('/issuers', async (request): Promise<{ issuers: Issuer[] }> => {
    const access = requirePermission(request, 'issuer:read');
    const rows = await db
      .select()
      .from(issuer)
      .where(eq(issuer.orgId, access.org.id))
      .orderBy(asc(issuer.createdAt));
    const issuerKeys = await keysForIssuers(
      db,
      access.org.id,
      rows.map((row) => row.id),
    );
    const files = await loadFiles(
      db,
      rows.map((row) => row.imageFileId),
    );
    const reviews = await loadReviews(db, rows);
    return {
      issuers: rows.map((row) =>
        serializeIssuer(config.publicBaseUrl, row, issuerKeys, files, reviews),
      ),
    };
  });

  /** Creates an issuer and its first Ed25519 signing key. */
  app.post('/issuers', async (request, reply) => {
    const access = requirePermission(request, 'issuer:create');
    requireWritable(access);
    const input = parse(issuerInput, request.body);

    const issuerId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(issuer)
        .values({
          orgId: access.org.id,
          name: input.name,
          url: input.url ?? null,
          email: input.email ?? null,
          description: input.description ?? null,
        })
        .returning();
      if (!row) throw new Error('Insert returned no row.');
      await reviewIssuerText(tx, config.moderation, access.org, row, access.userId, services.jobs);
      const key = await createSigningKey(tx, keys, { orgId: access.org.id, issuerId: row.id });
      // Fails the whole creation if the stored key doesn't decrypt to a working signer.
      await loadSigner(keys, config.publicBaseUrl, key);
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: access.actor,
        action: 'issuer.created',
        target: { type: 'issuer', id: row.id },
        data: { name: row.name, url: row.url, email: row.email },
        request: requestInfo(request),
      });
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: access.actor,
        action: 'signing_key.created',
        target: { type: 'signing_key', id: key.id },
        data: {
          issuerId: row.id,
          algorithm: key.algorithm,
          publicKeyMultibase: key.publicKeyMultibase,
        },
        request: requestInfo(request),
      });
      return row.id;
    });

    return reply.code(201).send(await load(access.org.id, issuerId));
  });

  app.get('/issuers/:issuerId', async (request) => {
    const access = requirePermission(request, 'issuer:read');
    const issuerId = uuidParam((request.params as { issuerId?: string }).issuerId, 'Issuer');
    return load(access.org.id, issuerId);
  });

  app.patch('/issuers/:issuerId', async (request) => {
    const access = requirePermission(request, 'issuer:update');
    requireWritable(access);
    const issuerId = uuidParam((request.params as { issuerId?: string }).issuerId, 'Issuer');
    const input = parse(updateIssuerInput, request.body);

    await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(issuer)
        .where(and(eq(issuer.orgId, access.org.id), eq(issuer.id, issuerId)))
        .for('update');
      if (!before) throw notFound('Issuer');
      const [after] = await tx
        .update(issuer)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.url !== undefined && { url: input.url, ...domainChanges(before, input.url) }),
          ...(input.email !== undefined && { email: input.email }),
          ...(input.description !== undefined && { description: input.description }),
          updatedAt: new Date(),
        })
        .where(and(eq(issuer.orgId, access.org.id), eq(issuer.id, issuerId)))
        .returning();
      if (!after) throw notFound('Issuer');
      await reviewIssuerText(
        tx,
        config.moderation,
        access.org,
        after,
        access.userId,
        services.jobs,
      );
      const diff = changes(before, after);
      if (Object.keys(diff).length > 0) {
        await recordAudit(tx, {
          orgId: access.org.id,
          actor: access.actor,
          action: 'issuer.updated',
          target: { type: 'issuer', id: issuerId },
          data: diff,
          request: requestInfo(request),
        });
      }
    });
    return load(access.org.id, issuerId);
  });

  /**
   * Sets the issuer's logo: the image file itself as the body (PNG, SVG, JPEG or WebP, up to
   * 2 MB). Badges awarded from now on carry it; earlier badges keep the logo they were signed with.
   */
  app.put('/issuers/:issuerId/logo', UPLOAD_ROUTE_OPTIONS, async (request, reply) => {
    const access = requirePermission(request, 'issuer:update');
    requireWritable(access);
    const issuerId = uuidParam((request.params as { issuerId?: string }).issuerId, 'Issuer');
    const [current] = await db
      .select({ id: issuer.id })
      .from(issuer)
      .where(and(eq(issuer.orgId, access.org.id), eq(issuer.id, issuerId)));
    if (!current) throw notFound('Issuer');

    const logo = await storeUploadedImage(
      db,
      storage,
      request,
      {
        orgId: access.org.id,
        kind: 'issuer_logo',
        subjectId: issuerId,
        createdBy: access.userId,
      },
      { config, limiter: uploadLimiter, org: access.org, reply },
    );
    const replaced = await db.transaction(async (tx) => {
      const [before] = await tx
        .select({ imageFileId: issuer.imageFileId })
        .from(issuer)
        .where(and(eq(issuer.orgId, access.org.id), eq(issuer.id, issuerId)))
        .for('update');
      if (!before) throw notFound('Issuer');
      await reviewImage(tx, config.moderation, access.org, logo, access.userId, services.jobs);
      if (before.imageFileId === logo.id) return null;
      await tx
        .update(issuer)
        .set({ imageFileId: logo.id, updatedAt: new Date() })
        .where(eq(issuer.id, issuerId));
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: access.actor,
        action: 'issuer.logo_changed',
        target: { type: 'issuer', id: issuerId },
        data: {
          sha256: logo.sha256,
          mimeType: logo.mimeType,
          width: logo.width,
          height: logo.height,
        },
        request: requestInfo(request),
      });
      return before.imageFileId;
    });
    // A logo no badge was ever signed with can go; others are kept (design plan §5.4).
    if (replaced) await deleteFiles(db, storage, [...(await loadFiles(db, [replaced])).values()]);
    return load(access.org.id, issuerId);
  });

  app.delete('/issuers/:issuerId/logo', async (request) => {
    const access = requirePermission(request, 'issuer:update');
    requireWritable(access);
    const issuerId = uuidParam((request.params as { issuerId?: string }).issuerId, 'Issuer');
    const removed = await db.transaction(async (tx) => {
      const [before] = await tx
        .select({ imageFileId: issuer.imageFileId })
        .from(issuer)
        .where(and(eq(issuer.orgId, access.org.id), eq(issuer.id, issuerId)))
        .for('update');
      if (!before) throw notFound('Issuer');
      if (!before.imageFileId) return null;
      await tx
        .update(issuer)
        .set({ imageFileId: null, updatedAt: new Date() })
        .where(eq(issuer.id, issuerId));
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: access.actor,
        action: 'issuer.logo_removed',
        target: { type: 'issuer', id: issuerId },
        request: requestInfo(request),
      });
      return before.imageFileId;
    });
    if (removed) await deleteFiles(db, storage, [...(await loadFiles(db, [removed])).values()]);
    return load(access.org.id, issuerId);
  });

  /**
   * Domain verification (design plan §6.3): the DNS TXT record or file that proves the issuer
   * controls its website's host. Public pages say "Website verified" only after a check finds it.
   */
  app.post('/issuers/:issuerId/domain-verification', async (request) => {
    const access = requirePermission(request, 'issuer:update');
    requireWritable(access);
    const issuerId = uuidParam((request.params as { issuerId?: string }).issuerId, 'Issuer');
    return db.transaction((tx) => startDomainVerification(tx, access.org.id, issuerId));
  });

  app.post('/issuers/:issuerId/domain-verification/check', async (request) => {
    const access = requirePermission(request, 'issuer:update');
    requireWritable(access);
    const issuerId = uuidParam((request.params as { issuerId?: string }).issuerId, 'Issuer');
    return checkDomain(
      db,
      domains,
      { orgId: access.org.id, issuerId },
      access.actor,
      requestInfo(request),
    );
  });
};
