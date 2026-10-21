import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { achievementRoutes } from '../achievements/routes';
import { apiKeyRoutes } from '../api-keys/routes';
import { auditRoutes } from '../audit/routes';
import { batchRoutes } from '../batches/routes';
import { credentialRoutes, erasureRoutes } from '../credentials/routes';
import { exportRoutes } from '../exports/routes';
import { issuerRoutes } from '../issuers/routes';
import { meRoutes } from '../me/routes';
import { installOrgAccess } from '../orgs/access';
import { invitationRoutes, publicInvitationRoutes } from '../orgs/invitations';
import { memberRoutes } from '../orgs/members';
import { orgRoutes, userOrgRoutes } from '../orgs/routes';
import { platformRoutes } from '../platform/routes';
import { recipientRoutes } from '../recipients/routes';
import type { Services } from '../services';
import { type VerifyRouteOptions, verifyRoutes } from '../verify/routes';
import { ApiError, problemErrorHandler } from './errors';
import type { RateLimiter } from './rate-limit';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type ApiResponseObserver = (
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
) => void;

/**
 * CSRF defense for cookie-authenticated requests (design plan §12): a state-changing request
 * must come from this origin. Browsers always send `Origin` on cross-origin and same-origin
 * POST/PATCH/DELETE requests made with fetch.
 */
export function checkOrigin(publicBaseUrl: string) {
  return async (request: FastifyRequest) => {
    if (SAFE_METHODS.has(request.method)) return;
    // Public endpoints that change nothing and use no cookies (verify) are open to any caller.
    if ((request.routeOptions.config as { anyOrigin?: boolean } | undefined)?.anyOrigin) return;
    if (isSameOrigin(request, publicBaseUrl)) return;
    // API keys travel in a header that browsers never add on their own, and a request that
    // carries one is never authenticated by its cookies (requireSession), so it can't be forged.
    if (request.headers.authorization) return;
    throw new ApiError(
      403,
      'bad_origin',
      'Request blocked',
      'The request did not come from this site.',
    );
  };
}

/**
 * Whether a request comes from this site. Browsers send `Origin`; under some referrer policies
 * they send `Origin: null` for same-origin requests, and then `Sec-Fetch-Site` (which pages
 * can't set) still says where it came from.
 */
export function isSameOrigin(request: FastifyRequest, publicBaseUrl: string): boolean {
  const origin = request.headers.origin;
  if (origin === publicBaseUrl) return true;
  return (
    (origin === undefined || origin === 'null') &&
    request.headers['sec-fetch-site'] === 'same-origin'
  );
}

/** The REST API (`/api/v1`). Every response is JSON, errors are `application/problem+json`. */
export const apiV1: FastifyPluginAsync<{
  services: Services;
  verify: Omit<VerifyRouteOptions, 'services'>;
  /** Requests per API key (design plan §10). */
  apiKeyLimiter: RateLimiter;
  /** Invitation links opened per client IP (shared with claim links). */
  linkLimiter: RateLimiter;
  /** Image and CSV uploads per org per hour (design plan §6.5). */
  uploadLimiter: RateLimiter;
  onApiResponse?: ApiResponseObserver;
}> = async (
  app,
  { services, verify, apiKeyLimiter, linkLimiter, uploadLimiter, onApiResponse },
) => {
  app.setErrorHandler(problemErrorHandler);
  if (onApiResponse) {
    app.addHook('onSend', async (request, reply, payload) => {
      onApiResponse(request, reply, payload);
      return payload;
    });
  }
  app.addHook('onRequest', checkOrigin(services.config.publicBaseUrl));
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  await app.register(meRoutes, { services });
  // My badges: the person's own badges and addresses, whatever orgs they belong to (§8.8).
  await app.register(recipientRoutes, { services });
  await app.register(userOrgRoutes, { services });
  await app.register(publicInvitationRoutes, { services, linkLimiter });
  await app.register(platformRoutes, { services, prefix: '/platform' });
  await app.register(verifyRoutes, { services, ...verify });

  // Everything under /orgs/:orgId is tenant-scoped: the caller must be a member of that org,
  // and every query filters on its id.
  await app.register(
    async (scoped) => {
      installOrgAccess(scoped, services, { apiKeyLimiter });
      await scoped.register(orgRoutes, { services });
      await scoped.register(memberRoutes, { services });
      await scoped.register(invitationRoutes, { services });
      await scoped.register(issuerRoutes, { services, uploadLimiter });
      await scoped.register(achievementRoutes, { services, uploadLimiter });
      await scoped.register(credentialRoutes, { services });
      await scoped.register(erasureRoutes, { services });
      await scoped.register(batchRoutes, { services, uploadLimiter });
      await scoped.register(exportRoutes, { services });
      await scoped.register(auditRoutes, { services });
      await scoped.register(apiKeyRoutes, { services });
    },
    { prefix: '/orgs/:orgId' },
  );
};
