import type { FastifyPluginAsync } from 'fastify';

export interface HealthRoutesOptions {
  /** Resolves when the database answers; rejects otherwise. */
  checkDatabase: () => Promise<void>;
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref();
    }),
  ]);
}

/**
 * `/healthz`: the process is up (Docker healthcheck, liveness).
 * `/readyz`: dependencies are reachable (readiness; returns 503 when not).
 */
export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (
  app,
  { checkDatabase, timeoutMs = 2000 },
) => {
  app.get('/healthz', { logLevel: 'warn' }, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { status: 'ok' };
  });

  app.get('/readyz', { logLevel: 'warn' }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      await withTimeout(checkDatabase(), timeoutMs);
      return { status: 'ready', checks: { database: 'ok' } };
    } catch (err) {
      request.log.warn({ err }, 'readiness check failed: database');
      return reply.code(503).send({ status: 'unavailable', checks: { database: 'error' } });
    }
  });
};
