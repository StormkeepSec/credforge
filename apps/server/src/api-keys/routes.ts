import {
  type ApiKey,
  type CreatedApiKey,
  createApiKeyInput,
  isApiKeyScope,
} from '@credforge/contracts';
import { and, apiKey, desc, eq, isNull, user } from '@credforge/db';
import type { FastifyPluginAsync } from 'fastify';
import { notFound, parse, uuidParam } from '../api/errors';
import { recordAudit } from '../audit/audit';
import { requestInfo, requireMember, requirePermission, requireWritable } from '../orgs/access';
import type { Services } from '../services';
import { generateApiKey } from './keys';

type ApiKeyRow = typeof apiKey.$inferSelect;

function serialize(row: ApiKeyRow, creator: { id: string; name: string } | null): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes.filter(isApiKeyScope),
    createdBy: creator,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/**
 * `/api/v1/orgs/:orgId/api-keys` (design plan §10, §12): owners and admins create keys for
 * integrations. A key is shown once; only its SHA-256 is stored. Managing keys always needs a
 * person signed in (a key can't create or revoke keys).
 */
export const apiKeyRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const { db } = services;

  app.get('/api-keys', async (request): Promise<{ apiKeys: ApiKey[] }> => {
    const access = requireMember(requirePermission(request, 'api_key:manage'));
    const rows = await db
      .select({ key: apiKey, creatorId: user.id, creatorName: user.name })
      .from(apiKey)
      .leftJoin(user, eq(apiKey.createdBy, user.id))
      .where(eq(apiKey.orgId, access.org.id))
      .orderBy(desc(apiKey.createdAt))
      .limit(200);
    return {
      apiKeys: rows.map((row) =>
        serialize(
          row.key,
          row.creatorId ? { id: row.creatorId, name: row.creatorName ?? '' } : null,
        ),
      ),
    };
  });

  app.post('/api-keys', async (request, reply) => {
    const access = requireMember(requirePermission(request, 'api_key:manage'));
    requireWritable(access);
    const input = parse(createApiKeyInput, request.body);
    const generated = generateApiKey();
    const now = new Date();
    const expiresAt = input.expiresInDays
      ? new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(apiKey)
        .values({
          orgId: access.org.id,
          name: input.name,
          prefix: generated.prefix,
          keyHash: generated.hash,
          scopes: input.scopes,
          createdBy: access.member.user.id,
          expiresAt,
          createdAt: now,
        })
        .returning();
      if (!created) throw new Error('API key insert returned no row.');
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: access.actor,
        action: 'api_key.created',
        target: { type: 'api_key', id: created.id },
        data: {
          name: input.name,
          prefix: generated.prefix,
          scopes: input.scopes,
          expiresAt: expiresAt?.toISOString() ?? null,
        },
        request: requestInfo(request),
      });
      return created;
    });

    const body: CreatedApiKey = {
      ...serialize(row, { id: access.member.user.id, name: access.member.user.name }),
      key: generated.key,
    };
    return reply.code(201).send(body);
  });

  /** Revokes a key at once. It stays listed (revoked), so the audit log keeps making sense. */
  app.delete('/api-keys/:keyId', async (request, reply) => {
    const access = requireMember(requirePermission(request, 'api_key:manage'));
    const id = uuidParam((request.params as { keyId?: string }).keyId, 'API key');
    await db.transaction(async (tx) => {
      const [revoked] = await tx
        .update(apiKey)
        .set({ revokedAt: new Date(), revokedBy: access.member.user.id })
        .where(and(eq(apiKey.orgId, access.org.id), eq(apiKey.id, id), isNull(apiKey.revokedAt)))
        .returning({ name: apiKey.name, prefix: apiKey.prefix });
      if (!revoked) {
        // Already revoked is fine; another org's key or none at all is a 404.
        const [existing] = await tx
          .select({ id: apiKey.id })
          .from(apiKey)
          .where(and(eq(apiKey.orgId, access.org.id), eq(apiKey.id, id)));
        if (!existing) throw notFound('API key');
        return;
      }
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: access.actor,
        action: 'api_key.revoked',
        target: { type: 'api_key', id },
        data: { name: revoked.name, prefix: revoked.prefix },
        request: requestInfo(request),
      });
    });
    return reply.code(204).send();
  });
};
