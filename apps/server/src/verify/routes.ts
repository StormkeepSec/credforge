import { type VerifyResult, verifyInput } from '@credforge/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { ApiError, parse } from '../api/errors';
import { createRateLimiter, type RateLimiter } from '../api/rate-limit';
import type { Services } from '../services';
import { createSafeFetcher, type DocumentFetcher } from './fetch';
import { verifyAny } from './service';

/** Baked images up to 2 MB, plus the credential and base64's third. */
export const VERIFY_BODY_LIMIT = 4 * 1024 * 1024;

export interface VerifyRouteOptions {
  services: Pick<Services, 'db' | 'config'>;
  /** Shared with the /verify page, so both count against the same limit. */
  limiter: RateLimiter;
  fetcher: DocumentFetcher;
}

/** One limiter and fetcher for the /verify page and `POST /api/v1/verify`. */
export function createVerifyTools(config: Services['config']) {
  return {
    limiter: createRateLimiter({ max: config.verifyRateLimit, windowMs: 60_000 }),
    fetcher: createSafeFetcher({
      userAgent: `credforge-verifier (+${config.publicBaseUrl}/verify)`,
    }),
  };
}

export function rateLimited(retryAfter: number) {
  return new ApiError(
    429,
    'rate_limited',
    'Too many checks',
    `Wait ${retryAfter} seconds, then try again.`,
  );
}

/**
 * `POST /api/v1/verify` (design plan §8.5): checks a credential given as `url`, `credential`
 * (JSON) or `image` (a baked PNG or SVG, base64), or a baked image sent as the raw body
 * (`Content-Type: image/png` or `image/svg+xml`). Public and rate limited per client.
 */
export const verifyRoutes: FastifyPluginAsync<VerifyRouteOptions> = async (
  app,
  { services, limiter, fetcher },
) => {
  app.addContentTypeParser(
    ['image/png', 'image/svg+xml'],
    { parseAs: 'buffer', bodyLimit: VERIFY_BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );

  app.post(
    '/verify',
    { bodyLimit: VERIFY_BODY_LIMIT, config: { anyOrigin: true } },
    async (request, reply): Promise<VerifyResult> => {
      const allowed = limiter.take(request.ip);
      if (!allowed.allowed) {
        reply.header('retry-after', String(allowed.retryAfter));
        throw rateLimited(allowed.retryAfter);
      }
      const input = Buffer.isBuffer(request.body)
        ? { image: request.body.toString('base64') }
        : parse(verifyInput, request.body);
      return verifyAny(
        { db: services.db, publicBaseUrl: services.config.publicBaseUrl, fetcher },
        input,
      );
    },
  );
};
