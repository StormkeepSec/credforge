import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { achievementRoutes } from '../achievements/routes';
import { auditRoutes } from '../audit/routes';
import { batchRoutes } from '../batches/routes';
import { credentialRoutes } from '../credentials/routes';
import { exportRoutes } from '../exports/routes';
import { issuerRoutes } from '../issuers/routes';
import { meRoutes } from '../me/routes';
import { installOrgAccess } from '../orgs/access';
import { invitationRoutes, publicInvitationRoutes } from '../orgs/invitations';
import { memberRoutes } from '../orgs/members';
import { orgRoutes, userOrgRoutes } from '../orgs/routes';
import { platformRoutes } from '../platform/routes';
import type { Services } from '../services';
import { type VerifyRouteOptions, verifyRoutes } from '../verify/routes';
import { ApiError, problemErrorHandler } from './errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
}> = async (app, { services, verify }) => {
  app.setErrorHandler(problemErrorHandler);
  app.addHook('onRequest', checkOrigin(services.config.publicBaseUrl));
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  await app.register(meRoutes, { services });
  await app.register(userOrgRoutes, { services });
  await app.register(publicInvitationRoutes, { services });
  await app.register(platformRoutes, { services, prefix: '/platform' });
  await app.register(verifyRoutes, { services, ...verify });

  // Everything under /orgs/:orgId is tenant-scoped: the caller must be a member of that org,
  // and every query filters on its id.
  await app.register(
    async (scoped) => {
      installOrgAccess(scoped, services);
      await scoped.register(orgRoutes, { services });
      await scoped.register(memberRoutes, { services });
      await scoped.register(invitationRoutes, { services });
      await scoped.register(issuerRoutes, { services });
      await scoped.register(achievementRoutes, { services });
      await scoped.register(credentialRoutes, { services });
      await scoped.register(batchRoutes, { services });
      await scoped.register(exportRoutes, { services });
      await scoped.register(auditRoutes, { services });
    },
    { prefix: '/orgs/:orgId' },
  );
};
