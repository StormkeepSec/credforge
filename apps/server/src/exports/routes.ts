import { Readable } from 'node:stream';
import { credentialFilters } from '@credforge/contracts';
import {
  achievement,
  and,
  asc,
  auditEvent,
  credential,
  eq,
  gt,
  inArray,
  type Queryable,
  sql,
  user,
} from '@credforge/db';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { parse } from '../api/errors';
import { recordAudit } from '../audit/audit';
import { CSV_BOM, csvLine } from '../batches/csv';
import {
  beforeCursor,
  credentialConditions,
  newestFirst,
  type ParsedCredentialFilters,
} from '../credentials/query';
import {
  type CredentialRow,
  credentialState,
  credentialUrl,
  deliveryStatus,
  emailsFor,
} from '../credentials/service';
import { requestInfo, requirePermission } from '../orgs/access';
import type { Services } from '../services';

const PAGE = 500;

/** One exported credential, in the same shape for CSV and JSONL. */
interface ExportRecord {
  id: string;
  url: string;
  achievementId: string;
  achievementName: string;
  achievementRevision: number;
  recipientName: string;
  recipientEmail: string;
  state: string;
  awardedAt: string;
  validFrom: string;
  validUntil: string | null;
  delivery: string;
  openedAt: string | null;
  visibility: string;
  revokedAt: string | null;
  revocationKind: string | null;
  revocationReason: string | null;
  revocationPublicReason: string | null;
  replacedById: string | null;
  replacesId: string | null;
  batchId: string | null;
  awardedBy: string | null;
  customFields: Record<string, string>;
}

/** The org's credentials matching the filters, newest first, a page at a time. */
async function* exportRecords(
  db: Queryable,
  publicBaseUrl: string,
  orgId: string,
  filters: ParsedCredentialFilters,
): AsyncGenerator<{ record: ExportRecord; document: Record<string, unknown> }[]> {
  const now = new Date();
  const labels = new Map<string, string>();
  let cursor: { at: Date; id: string } | undefined;
  for (;;) {
    const rows: { credential: CredentialRow; achievementName: string }[] = await db
      .select({ credential, achievementName: achievement.name })
      .from(credential)
      .innerJoin(achievement, eq(credential.achievementId, achievement.id))
      .where(and(credentialConditions(orgId, filters, now), beforeCursor(cursor)))
      .orderBy(...newestFirst)
      .limit(PAGE);
    if (rows.length === 0) return;
    const emails = await emailsFor(
      db,
      orgId,
      rows.map((row) => row.credential.id),
    );
    const missing = [
      ...new Set(
        rows
          .map((row) => row.credential.issuedById)
          .filter((id): id is string => Boolean(id) && !labels.has(id as string)),
      ),
    ];
    if (missing.length > 0) {
      for (const row of await db
        .select({ id: user.id, email: user.email })
        .from(user)
        .where(inArray(user.id, missing))) {
        labels.set(row.id, row.email);
      }
    }
    yield rows.map(({ credential: row, achievementName }) => {
      const sent = emails.get(row.id) ?? [];
      return {
        document: row.document,
        record: {
          id: row.id,
          url: credentialUrl(publicBaseUrl, row.id),
          achievementId: row.achievementId,
          achievementName,
          achievementRevision: row.achievementRevision,
          recipientName: row.recipientName,
          recipientEmail: row.recipientEmail,
          state: credentialState(row, now),
          awardedAt: row.createdAt.toISOString(),
          validFrom: row.validFrom.toISOString(),
          validUntil: row.validUntil?.toISOString() ?? null,
          delivery: deliveryStatus(sent),
          openedAt: row.acceptedAt?.toISOString() ?? null,
          visibility: row.visibility,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          revocationKind: row.status === 'revoked' ? (row.revocationKind ?? 'revoked') : null,
          revocationReason: row.revocationReason,
          revocationPublicReason: row.revocationPublicReason,
          replacedById: row.replacedById,
          replacesId: row.replacesId,
          batchId: row.batchId,
          awardedBy: row.issuedById ? (labels.get(row.issuedById) ?? null) : null,
          customFields: row.customFields,
        },
      };
    });
    const last = rows.at(-1)?.credential;
    if (!last || rows.length < PAGE) return;
    cursor = { at: last.createdAt, id: last.id };
  }
}

const CSV_COLUMNS: [string, (record: ExportRecord) => unknown][] = [
  ['Credential ID', (r) => r.id],
  ['Credential URL', (r) => r.url],
  ['Achievement', (r) => r.achievementName],
  ['Achievement ID', (r) => r.achievementId],
  ['Achievement revision', (r) => r.achievementRevision],
  ['Recipient name', (r) => r.recipientName],
  ['Recipient email', (r) => r.recipientEmail],
  ['Status', (r) => r.state],
  ['Awarded at', (r) => r.awardedAt],
  ['Valid from', (r) => r.validFrom],
  ['Valid until', (r) => r.validUntil],
  ['Email', (r) => r.delivery],
  ['Opened at', (r) => r.openedAt],
  ['Page', (r) => r.visibility],
  ['Revoked at', (r) => r.revokedAt],
  ['Revocation', (r) => r.revocationKind],
  ['Internal reason', (r) => r.revocationReason],
  ['Public reason', (r) => r.revocationPublicReason],
  ['Replaced by', (r) => r.replacedById],
  ['Replaces', (r) => r.replacesId],
  ['Batch', (r) => r.batchId],
  ['Awarded by', (r) => r.awardedBy],
];

/** Custom-field names used by the exported credentials, for the CSV's extra columns. */
async function customKeys(db: Queryable, orgId: string, filters: ParsedCredentialFilters) {
  const rows = await db
    .selectDistinct({ key: sql<string>`jsonb_object_keys(${credential.customFields})` })
    .from(credential)
    .where(credentialConditions(orgId, filters))
    .limit(100);
  return rows.map((row) => row.key).sort();
}

const today = () => new Date().toISOString().slice(0, 10);

function download(reply: FastifyReply, type: string, name: string, body: AsyncGenerator<string>) {
  return reply
    .type(type)
    .header('content-disposition', `attachment; filename="${name}"`)
    .send(Readable.from(body));
}

/**
 * `/api/v1/orgs/:orgId/exports`: the org's records (design plan §10, initial-release criterion 7).
 *
 * - `credentials.csv` / `credentials.jsonl`: every credential matching the same search and
 *   filters as the list. The CSV escapes values a spreadsheet would run as formulas; each JSONL
 *   line also carries the signed credential.
 * - `audit-events.csv` / `audit-events.jsonl`: the whole audit log, oldest first.
 *
 * Exports are streamed straight from the database (nothing is stored), and each one is itself
 * recorded in the audit log.
 */
export const exportRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const { db, config } = services;

  app.get('/exports/credentials.csv', async (request, reply) => {
    const access = requirePermission(request, 'credential:export');
    const filters = parse(credentialFilters, request.query);
    const extra = await customKeys(db, access.org.id, filters);
    await recordAudit(db, {
      orgId: access.org.id,
      actor: access.actor,
      action: 'credentials.exported',
      data: { format: 'csv', filters },
      request: requestInfo(request),
    });
    async function* body() {
      yield CSV_BOM +
        csvLine([...CSV_COLUMNS.map(([name]) => name), ...extra.map((key) => `Custom: ${key}`)]);
      for await (const page of exportRecords(db, config.publicBaseUrl, access.org.id, filters)) {
        yield page
          .map(({ record }) =>
            csvLine([
              ...CSV_COLUMNS.map(([, value]) => value(record)),
              ...extra.map((key) => record.customFields[key] ?? ''),
            ]),
          )
          .join('');
      }
    }
    return download(reply, 'text/csv; charset=utf-8', `credentials-${today()}.csv`, body());
  });

  app.get('/exports/credentials.jsonl', async (request, reply) => {
    const access = requirePermission(request, 'credential:export');
    const filters = parse(credentialFilters, request.query);
    await recordAudit(db, {
      orgId: access.org.id,
      actor: access.actor,
      action: 'credentials.exported',
      data: { format: 'jsonl', filters },
      request: requestInfo(request),
    });
    async function* body() {
      for await (const page of exportRecords(db, config.publicBaseUrl, access.org.id, filters)) {
        yield page
          .map(({ record, document }) => `${JSON.stringify({ ...record, credential: document })}\n`)
          .join('');
      }
    }
    return download(
      reply,
      'application/jsonl; charset=utf-8',
      `credentials-${today()}.jsonl`,
      body(),
    );
  });

  async function* auditPages(orgId: string) {
    let after = 0;
    for (;;) {
      const rows = await db
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.orgId, orgId), gt(auditEvent.id, after)))
        .orderBy(asc(auditEvent.id))
        .limit(PAGE);
      if (rows.length === 0) return;
      yield rows;
      after = rows.at(-1)?.id ?? after;
      if (rows.length < PAGE) return;
    }
  }

  app.get('/exports/audit-events.csv', async (request, reply) => {
    const access = requirePermission(request, 'audit:read');
    await recordAudit(db, {
      orgId: access.org.id,
      actor: access.actor,
      action: 'audit.exported',
      data: { format: 'csv' },
      request: requestInfo(request),
    });
    async function* body() {
      yield CSV_BOM +
        csvLine([
          'ID',
          'Time',
          'Action',
          'Actor type',
          'Actor',
          'Target type',
          'Target',
          'IP',
          'Data',
        ]);
      for await (const rows of auditPages(access.org.id)) {
        yield rows
          .map((row) =>
            csvLine([
              row.id,
              row.createdAt.toISOString(),
              row.action,
              row.actorType,
              row.actorLabel ?? row.actorId,
              row.targetType,
              row.targetId,
              row.ip,
              JSON.stringify(row.data),
            ]),
          )
          .join('');
      }
    }
    return download(reply, 'text/csv; charset=utf-8', `audit-log-${today()}.csv`, body());
  });

  app.get('/exports/audit-events.jsonl', async (request, reply) => {
    const access = requirePermission(request, 'audit:read');
    await recordAudit(db, {
      orgId: access.org.id,
      actor: access.actor,
      action: 'audit.exported',
      data: { format: 'jsonl' },
      request: requestInfo(request),
    });
    async function* body() {
      for await (const rows of auditPages(access.org.id)) {
        yield rows
          .map(
            (row) =>
              `${JSON.stringify({
                id: row.id,
                at: row.createdAt.toISOString(),
                action: row.action,
                actor: { type: row.actorType, id: row.actorId, label: row.actorLabel },
                target: row.targetType ? { type: row.targetType, id: row.targetId } : null,
                ip: row.ip,
                data: row.data,
              })}\n`,
          )
          .join('');
      }
    }
    return download(
      reply,
      'application/jsonl; charset=utf-8',
      `audit-log-${today()}.jsonl`,
      body(),
    );
  });
};
