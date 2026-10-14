import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type { Config } from './config';
import { loggerOptions } from './logger';
import { resolvePublicAssets } from './public/assets';
import { createNotFoundHandler, publicPages } from './public/routes';
import { healthRoutes } from './routes/health';
import { webApp } from './web-app';

export interface AppDependencies {
  config: Config;
  checkDatabase: () => Promise<void>;
  /** Override logging (tests pass `false`). */
  logger?: FastifyServerOptions['logger'];
}

const REQUEST_ID_PATTERN = /^[\w-]{8,128}$/;

export async function buildApp({ config, checkDatabase, logger }: AppDependencies) {
  const app = Fastify({
    logger: logger ?? loggerOptions(config),
    trustProxy: config.trustProxy,
    // Reuse a well-formed X-Request-Id from the reverse proxy; otherwise mint one.
    requestIdHeader: false,
    genReqId(request) {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
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
    // HSTS only when served over HTTPS (nginx may also set it).
    strictTransportSecurity: isHttps ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  const assets = resolvePublicAssets(config);
  await app.register(healthRoutes, { checkDatabase });
  await app.register(publicPages, { config, assets });
  await app.register(webApp, { webDistDir: config.webDistDir });
  app.setNotFoundHandler(createNotFoundHandler({ config, assets }));

  return app;
}
