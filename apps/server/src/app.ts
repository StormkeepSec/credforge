import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyServerOptions,
  type RouteOptions,
} from 'fastify';
import { apiDocsRoutes } from './api/docs-routes';
import { createRateLimiter } from './api/rate-limit';
import { type ApiResponseObserver, apiV1 } from './api/v1';
import { authRoutes } from './auth/routes';
import type { Config } from './config';
import { sendgridWebhookRoutes } from './email/webhook-routes';
import { loggerOptions } from './logger';
import { resolvePublicAssets } from './public/assets';
import { publicCredentialRoutes } from './public/credential-routes';
import { publicImageRoutes } from './public/image-routes';
import { publicIssuerRoutes } from './public/issuer-routes';
import { createNotFoundHandler, publicPages } from './public/routes';
import { publicVerifyRoutes } from './public/verify-routes';
import { healthRoutes } from './routes/health';
import type { Services } from './services';
import type { DocumentFetcher } from './verify/fetch';
import { createVerifyTools } from './verify/routes';
import { webApp } from './web-app';

export interface AppDependencies {
  config: Config;
  checkDatabase: () => Promise<void>;
  /** Database-backed features (auth, API, issuer pages). Left out by tests of the bare shell. */
  services?: Services;
  /** Override logging (tests pass `false`). */
  logger?: FastifyServerOptions['logger'];
  /** A logger shared with code outside Fastify (server.ts). */
  loggerInstance?: FastifyBaseLogger;
  /** Sees every route as it is registered (the cross-tenant tests check they cover them all). */
  onRoute?: (route: RouteOptions) => void;
  /** Fetches other issuers' documents for /verify (tests pass a stand-in). */
  verifyFetcher?: DocumentFetcher;
  /** Sees every `/api/v1` response (tests check them against the OpenAPI schemas). */
  onApiResponse?: ApiResponseObserver;
}

/** Browser features no credforge page uses (design plan §12). */
export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()';

const REQUEST_ID_PATTERN = /^[\w-]{8,128}$/;

export async function buildApp({
  config,
  checkDatabase,
  services,
  logger,
  loggerInstance,
  onRoute,
  verifyFetcher,
  onApiResponse,
}: AppDependencies) {
  const app = Fastify({
    ...(loggerInstance ? { loggerInstance } : { logger: logger ?? loggerOptions(config) }),
    trustProxy: config.trustProxy,
    // nginx buffers request bodies; a request that still takes this long is stuck.
    requestTimeout: 120_000,
    // Reuse a well-formed X-Request-Id from the reverse proxy; otherwise mint one.
    requestIdHeader: false,
    genReqId(request) {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  if (onRoute) app.addHook('onRoute', onRoute);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('permissions-policy', PERMISSIONS_POLICY);
  });

  const isHttps = config.publicBaseUrl.startsWith('https://');
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        upgradeInsecureRequests: isHttps ? [] : null,
      },
    },
    // No referrer to other sites. Same-origin requests keep theirs, so browsers send a real
    // Origin header on the app's own form posts and fetches (with no-referrer they send "null").
    referrerPolicy: { policy: 'same-origin' },
    // Matches the CSP's frame-ancestors 'none' for browsers that only know this header.
    xFrameOptions: { action: 'deny' },
    // HSTS only when served over HTTPS (nginx may also set it).
    strictTransportSecurity: isHttps ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  const assets = resolvePublicAssets(config);
  await app.register(healthRoutes, { checkDatabase });
  await app.register(publicPages, { config, assets });
  await app.register(apiDocsRoutes, { config });
  if (services) {
    const tools = createVerifyTools(services.config);
    const verify = { limiter: tools.limiter, fetcher: verifyFetcher ?? tools.fetcher };
    // In memory: one app process behind nginx (design plan §3). `/status/` is never limited.
    const apiKeyLimiter = createRateLimiter({ max: config.apiRateLimit, windowMs: 60_000 });
    const linkLimiter = createRateLimiter({ max: config.claimRateLimit, windowMs: 60_000 });
    await app.register(authRoutes, services);
    await app.register(apiV1, {
      services,
      verify,
      apiKeyLimiter,
      linkLimiter,
      onApiResponse,
      prefix: '/api/v1',
    });
    await app.register(publicIssuerRoutes, { services, assets });
    await app.register(publicImageRoutes, { services });
    await app.register(publicCredentialRoutes, { services, assets, claimLimiter: linkLimiter });
    await app.register(publicVerifyRoutes, { services, assets, ...verify });
    await app.register(sendgridWebhookRoutes, { services });
  }
  await app.register(webApp, { webDistDir: config.webDistDir });
  app.setNotFoundHandler(createNotFoundHandler({ config, assets }));

  return app;
}
