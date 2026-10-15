import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyPluginAsync } from 'fastify';
import { type AuthResolverDeps, resolveAuth } from '../api/auth-context';
import type { Config } from '../config';
import { AUTH_BASE_PATH, CLIENT_IP_HEADER } from './auth';
import { isAuthPathAllowed } from './mfa';

export interface AuthRoutesOptions extends AuthResolverDeps {
  config: AuthResolverDeps['config'] & Pick<Config, 'publicBaseUrl'>;
}

/** Response headers Fastify sets itself when it sends the body. */
const SKIPPED_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'set-cookie',
]);

/**
 * Serves Better Auth at /api/auth/*, with credforge's second-factor gate in front of it: a
 * session that hasn't passed two-step verification (or must still set it up) can only reach
 * the endpoints that get it there (see `isAuthPathAllowed`).
 */
export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, deps) => {
  // Forward bodies exactly as received; Better Auth parses them itself.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => done(null, body));

  app.route({
    method: ['GET', 'POST'],
    url: `${AUTH_BASE_PATH}/*`,
    handler: async (request, reply) => {
      const url = new URL(request.url, deps.config.publicBaseUrl);
      const path = url.pathname.slice(AUTH_BASE_PATH.length) || '/';

      if (request.headers.cookie && !isAuthPathAllowed(path, 'challenge')) {
        const context = await resolveAuth(deps, request, reply);
        if (context && !isAuthPathAllowed(path, context.mfa.state)) {
          const setup = context.mfa.state === 'setup';
          return reply.code(403).send({
            code: setup ? 'MFA_SETUP_REQUIRED' : 'MFA_REQUIRED',
            message: setup
              ? 'Turn on two-step verification first.'
              : 'Enter a code from your authenticator app first.',
          });
        }
      }

      const headers = fromNodeHeaders(request.headers);
      headers.set(CLIENT_IP_HEADER, request.ip);
      const hasBody = request.method !== 'GET' && typeof request.body === 'string';
      const response = await deps.auth.handler(
        new Request(url, {
          method: request.method,
          headers,
          body: hasBody ? (request.body as string) : undefined,
        }),
      );

      reply.code(response.status);
      response.headers.forEach((value, key) => {
        if (!SKIPPED_HEADERS.has(key)) reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header('set-cookie', cookies);
      return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    },
  });
};
