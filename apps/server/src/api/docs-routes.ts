import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { Config } from '../config';
import { buildOpenApiDocument } from './openapi';

const swaggerDir = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));

/** Swagger UI's own files that the page loads; nothing else from the package is served. */
const SWAGGER_FILES: Record<string, string> = {
  'swagger-ui.css': 'text/css; charset=utf-8',
  'swagger-ui-bundle.js': 'text/javascript; charset=utf-8',
};

const INIT_JS = `window.addEventListener('load', function () {
  window.ui = SwaggerUIBundle({
    url: '/api/v1/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    validatorUrl: null,
    defaultModelsExpandDepth: 0,
    docExpansion: 'list',
  });
});
`;

const DOCS_CSS = `body { margin: 0; background: #fafafa; }
.cf-bar { background: #111827; color: #fafafa; font: 600 1rem/1.5 "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif; }
.cf-bar div { max-width: 1460px; margin: 0 auto; padding: 0.875rem 20px; display: flex; gap: 1.5rem; align-items: center; justify-content: space-between; }
.cf-bar a { color: #fafafa; }
.swagger-ui .topbar { display: none; }
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>credforge API</title>
<meta name="description" content="Interactive documentation of the credforge REST API (OpenAPI 3.1).">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/api/docs/assets/swagger-ui.css">
<link rel="stylesheet" href="/api/docs/assets/docs.css">
</head>
<body>
<header class="cf-bar"><div><a href="/">credforge</a><a href="/api/v1/openapi.json">openapi.json</a></div></header>
<main id="swagger-ui"></main>
<noscript><p>The interactive documentation needs JavaScript. The API description itself is at <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.</p></noscript>
<script src="/api/docs/assets/swagger-ui-bundle.js"></script>
<script src="/api/docs/assets/init.js"></script>
</body>
</html>
`;

/**
 * Swagger UI sets inline style attributes, so its page relaxes `style-src` (only there); scripts
 * stay `'self'`. Everything is served from this origin: no CDN.
 */
const DOCS_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join('; ');

/** `/api/docs`: interactive API docs; `/api/v1/openapi.json`: the OpenAPI 3.1 document. */
export const apiDocsRoutes: FastifyPluginAsync<{ config: Pick<Config, 'publicBaseUrl'> }> = async (
  app,
  { config },
) => {
  const document = JSON.stringify(buildOpenApiDocument(config.publicBaseUrl));

  app.get('/api/v1/openapi.json', async (_request, reply) =>
    reply
      .header('cache-control', 'public, max-age=300')
      .header('access-control-allow-origin', '*')
      .type('application/json; charset=utf-8')
      .send(document),
  );

  app.get('/api/docs', async (_request, reply) =>
    reply
      .header('content-security-policy', DOCS_CSP)
      .header('cache-control', 'public, max-age=300')
      .type('text/html; charset=utf-8')
      .send(PAGE),
  );

  app.get('/api/docs/assets/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    reply.header('cache-control', 'public, max-age=3600');
    if (name === 'init.js') return reply.type('text/javascript; charset=utf-8').send(INIT_JS);
    if (name === 'docs.css') return reply.type('text/css; charset=utf-8').send(DOCS_CSS);
    const type = SWAGGER_FILES[name];
    if (!type) return reply.callNotFound();
    return reply.type(type).send(createReadStream(join(swaggerDir, name)));
  });
};
