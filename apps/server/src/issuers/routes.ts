import { type Issuer, issuerInput, updateIssuerInput } from '@credforge/contracts';
import { and, asc, eq, issuer } from '@credforge/db';
import type { FastifyPluginAsync } from 'fastify';
import { notFound, parse, uuidParam } from '../api/errors';
import { recordAudit } from '../audit/audit';
import { requestInfo, requirePermission, requireWritable, userActor } from '../orgs/access';
import type { Services } from '../services';
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
export const issuerRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const { db, keys, config } = services;

  async function load(orgId: string, issuerId: string): Promise<Issuer> {
    const [row] = await db
      .select()
      .from(issuer)
      .where(and(eq(issuer.orgId, orgId), eq(issuer.id, issuerId)));
    if (!row) throw notFound('Issuer');
    return serializeIssuer(config.publicBaseUrl, row, await keysForIssuers(db, orgId, [row.id]));
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
    return { issuers: rows.map((row) => serializeIssuer(config.publicBaseUrl, row, issuerKeys)) };
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
      const key = await createSigningKey(tx, keys, { orgId: access.org.id, issuerId: row.id });
      // Fails the whole creation if the stored key doesn't decrypt to a working signer.
      await loadSigner(keys, config.publicBaseUrl, key);
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: userActor(access.actor),
        action: 'issuer.created',
        target: { type: 'issuer', id: row.id },
        data: { name: row.name, url: row.url, email: row.email },
        request: requestInfo(request),
      });
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: userActor(access.actor),
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
          ...(input.url !== undefined && { url: input.url }),
          ...(input.email !== undefined && { email: input.email }),
          ...(input.description !== undefined && { description: input.description }),
          updatedAt: new Date(),
        })
        .where(and(eq(issuer.orgId, access.org.id), eq(issuer.id, issuerId)))
        .returning();
      if (!after) throw notFound('Issuer');
      const diff = changes(before, after);
      if (Object.keys(diff).length > 0) {
        await recordAudit(tx, {
          orgId: access.org.id,
          actor: userActor(access.actor),
          action: 'issuer.updated',
          target: { type: 'issuer', id: issuerId },
          data: diff,
          request: requestInfo(request),
        });
      }
    });
    return load(access.org.id, issuerId);
  });
};
