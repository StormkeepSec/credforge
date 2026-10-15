import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { auditRoutes } from '../audit/routes';
import { issuerRoutes } from '../issuers/routes';
import { meRoutes } from '../me/routes';
import { installOrgAccess } from '../orgs/access';
import { invitationRoutes, publicInvitationRoutes } from '../orgs/invitations';
import { memberRoutes } from '../orgs/members';
import { orgRoutes, userOrgRoutes } from '../orgs/routes';
import { platformRoutes } from '../platform/routes';
import type { Services } from '../services';
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
    const origin = request.headers.origin;
    if (origin === publicBaseUrl) return;
    if (!origin && request.headers['sec-fetch-site'] === 'same-origin') return;
    throw new ApiError(
      403,
      'bad_origin',
      'Request blocked',
      'The request did not come from this site.',
    );
  };
}

/** The REST API (`/api/v1`). Every response is JSON, errors are `application/problem+json`. */
export const apiV1: FastifyPluginAsync<{ services: Services }> = async (app, { services }) => {
  app.setErrorHandler(problemErrorHandler);
  app.addHook('onRequest', checkOrigin(services.config.publicBaseUrl));
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  await app.register(meRoutes, { services });
  await app.register(userOrgRoutes, { services });
  await app.register(publicInvitationRoutes, { services });
  await app.register(platformRoutes, { services, prefix: '/platform' });

  // Everything under /orgs/:orgId is tenant-scoped: the caller must be a member of that org,
  // and every query filters on its id.
  await app.register(
    async (scoped) => {
      installOrgAccess(scoped, services);
      await scoped.register(orgRoutes, { services });
      await scoped.register(memberRoutes, { services });
      await scoped.register(invitationRoutes, { services });
      await scoped.register(issuerRoutes, { services });
      await scoped.register(auditRoutes, { services });
    },
    { prefix: '/orgs/:orgId' },
  );
};
