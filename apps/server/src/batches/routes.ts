import { Readable } from 'node:stream';
import {
  BATCH_LIMITS,
  type BatchDetails,
  type BatchPage,
  type BatchRowPage,
  batchCsvQuery,
  batchesQuery,
  batchRowsQuery,
  createBatchFromRowsInput,
  updateBatchInput,
} from '@credforge/contracts';
import { and, asc, desc, eq, gt, issuanceBatch, issuanceBatchRow, lt, or } from '@credforge/db';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, parse, uuidParam } from '../api/errors';
import type { RateLimiter } from '../api/rate-limit';
import { checkUpload } from '../files/limits';
import { requestInfo, requirePermission, requireWritable } from '../orgs/access';
import type { Services } from '../services';
import { TEMPLATE_CSV } from './csv';
import {
  confirmBatch,
  createCsvBatch,
  createRowsBatch,
  dataRowsCondition,
  deleteBatch,
  loadBatch,
  loadBatchDetails,
  resultsCsv,
  serializeBatches,
  serializeBatchRow,
  updateBatch,
} from './service';

/** How browsers and spreadsheets label CSV files (Excel on Windows says `vnd.ms-excel`). */
const CSV_CONTENT_TYPES = ['text/csv', 'application/csv', 'application/vnd.ms-excel'];

const idOf = (request: FastifyRequest) =>
  uuidParam((request.params as { batchId?: string }).batchId, 'Batch');

function parseCursor(value: string | undefined): { at: Date; id: string } | undefined {
  if (!value) return undefined;
  const [at, id] = value.split('_');
  const date = new Date(at ?? '');
  if (!id || Number.isNaN(date.getTime()) || !z.uuid().safeParse(id).success) {
    throw new ApiError(400, 'validation_failed', 'Invalid cursor');
  }
  return { at: date, id };
}

/** A download name from a file name: `results-learners.csv`. */
function resultsName(fileName: string | null): string {
  const stem = (fileName ?? 'batch')
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `results-${stem || 'batch'}.csv`;
}

/**
 * `/api/v1/orgs/:orgId/batches`: award many (design plan §8.3). Upload a CSV file (the raw file
 * as the body, `Content-Type: text/csv`) or send JSON rows; check and adjust the column mapping
 * while it is a draft; confirm it; follow its progress; download the results.
 */
export const batchRoutes: FastifyPluginAsync<{
  services: Services;
  /** Uploads per org (shared by every upload route). */
  uploadLimiter: RateLimiter;
}> = async (app, { services, uploadLimiter }) => {
  const { db, config } = services;

  app.addContentTypeParser(
    CSV_CONTENT_TYPES,
    { parseAs: 'buffer', bodyLimit: BATCH_LIMITS.maxBytes },
    (_request, body, done) => done(null, body),
  );

  app.get('/batches', async (request): Promise<BatchPage> => {
    const access = requirePermission(request, 'credential:read');
    const query = parse(batchesQuery, request.query);
    const cursor = parseCursor(query.before);
    const rows = await db
      .select()
      .from(issuanceBatch)
      .where(
        and(
          eq(issuanceBatch.orgId, access.org.id),
          cursor
            ? or(
                lt(issuanceBatch.createdAt, cursor.at),
                and(eq(issuanceBatch.createdAt, cursor.at), lt(issuanceBatch.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(issuanceBatch.createdAt), desc(issuanceBatch.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      batches: await serializeBatches(db, page),
      next: rows.length > query.limit && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
    };
  });

  /** The CSV template: the column names credforge recognizes. */
  app.get('/batches/template.csv', async (request, reply) => {
    requirePermission(request, 'credential:read');
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="credforge-award-template.csv"')
      .send(TEMPLATE_CSV);
  });

  /**
   * Creates a draft. A CSV file is the raw body (`?achievementId=…&fileName=…`); JSON rows are a
   * `createBatchFromRowsInput` body. Either way every row is checked and the answer is the
   * validation report.
   */
  app.post('/batches', { bodyLimit: BATCH_LIMITS.maxBytes }, async (request, reply) => {
    const access = requirePermission(request, 'credential:issue');
    requireWritable(access);
    const actor = access.actor;
    const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
    let id: string;
    if (CSV_CONTENT_TYPES.includes(contentType)) {
      const query = parse(batchCsvQuery, request.query);
      const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (bytes.length === 0) {
        throw new ApiError(400, 'invalid_csv', 'Can’t use this file', 'The file is empty.');
      }
      await checkUpload(db, config, uploadLimiter, access.org, bytes.length, reply);
      id = await createCsvBatch(
        services,
        { orgId: access.org.id },
        { achievementId: query.achievementId, fileName: query.fileName ?? null, bytes },
        actor,
        requestInfo(request),
      );
    } else {
      const input = parse(createBatchFromRowsInput, request.body);
      id = await createRowsBatch(
        services,
        { orgId: access.org.id },
        input,
        actor,
        requestInfo(request),
      );
    }
    return reply.code(201).send(await loadBatchDetails(db, config, access.org.id, id));
  });

  app.get('/batches/:batchId', async (request): Promise<BatchDetails> => {
    const access = requirePermission(request, 'credential:read');
    return loadBatchDetails(db, config, access.org.id, idOf(request));
  });

  app.patch('/batches/:batchId', async (request): Promise<BatchDetails> => {
    const access = requirePermission(request, 'credential:issue');
    requireWritable(access);
    const batchId = idOf(request);
    await updateBatch(services, access.org.id, batchId, parse(updateBatchInput, request.body));
    return loadBatchDetails(db, config, access.org.id, batchId);
  });

  app.delete('/batches/:batchId', async (request, reply) => {
    const access = requirePermission(request, 'credential:issue');
    requireWritable(access);
    await deleteBatch(services, access.org.id, idOf(request), access.actor, requestInfo(request));
    return reply.code(204).send();
  });

  /** Confirms a draft: its rows are queued and issued by the worker. */
  app.post('/batches/:batchId/confirm', async (request): Promise<BatchDetails> => {
    const access = requirePermission(request, 'credential:issue');
    requireWritable(access);
    const batchId = idOf(request);
    await confirmBatch(services, access.org.id, batchId, access.actor, requestInfo(request));
    return loadBatchDetails(db, config, access.org.id, batchId);
  });

  /** The rows, in file order, optionally only those with a check result or status. */
  app.get('/batches/:batchId/rows', async (request): Promise<BatchRowPage> => {
    const access = requirePermission(request, 'credential:read');
    const query = parse(batchRowsQuery, request.query);
    const batch = await loadBatch(db, access.org.id, idOf(request));
    const rows = await db
      .select()
      .from(issuanceBatchRow)
      .where(
        and(
          dataRowsCondition(batch),
          query.validation ? eq(issuanceBatchRow.validation, query.validation) : undefined,
          query.status ? eq(issuanceBatchRow.status, query.status) : undefined,
          query.after !== undefined ? gt(issuanceBatchRow.rowNumber, query.after) : undefined,
        ),
      )
      .orderBy(asc(issuanceBatchRow.rowNumber))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return {
      rows: page.map((row) => serializeBatchRow(config.publicBaseUrl, row)),
      next: rows.length > query.limit ? (page.at(-1)?.rowNumber ?? null) : null,
    };
  });

  /** Every row with its credential's URL or the reason it wasn't awarded. */
  app.get('/batches/:batchId/results.csv', async (request, reply) => {
    const access = requirePermission(request, 'credential:read');
    const batch = await loadBatch(db, access.org.id, idOf(request));
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${resultsName(batch.fileName)}"`)
      .send(Readable.from(resultsCsv(db, config.publicBaseUrl, batch)));
  });
};
