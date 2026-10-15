import { type AuditEventPage, auditEventsQuery } from '@credforge/contracts';
import { and, auditEvent, desc, eq, lt } from '@credforge/db';
import type { FastifyPluginAsync } from 'fastify';
import { parse } from '../api/errors';
import { requirePermission } from '../orgs/access';
import type { Services } from '../services';

/** `GET /api/v1/orgs/:orgId/audit-events`: newest first, paged with `before`. */
export const auditRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const { db } = services;

  app.get('/audit-events', async (request): Promise<AuditEventPage> => {
    const access = requirePermission(request, 'audit:read');
    const { before, limit } = parse(auditEventsQuery, request.query);
    const rows = await db
      .select()
      .from(auditEvent)
      .where(
        and(eq(auditEvent.orgId, access.org.id), before ? lt(auditEvent.id, before) : undefined),
      )
      .orderBy(desc(auditEvent.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      events: page.map((row) => ({
        id: row.id,
        action: row.action,
        actor: { type: row.actorType, id: row.actorId, label: row.actorLabel },
        target: row.targetType && row.targetId ? { type: row.targetType, id: row.targetId } : null,
        data: row.data,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
      })),
      next: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  });
};
