import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { PublicAssets } from './assets';
import { renderDocument } from './document';
import { LandingPage } from './pages/landing';
import { NotFoundPage } from './pages/not-found';

export interface PublicPagesOptions {
  config: Pick<Config, 'publicBaseUrl' | 'landingPage'>;
  assets: PublicAssets;
}

function sendHtml(reply: FastifyReply, html: string) {
  return reply.type('text/html; charset=utf-8').send(html);
}

/** Server-rendered public pages. */
export const publicPages: FastifyPluginAsync<PublicPagesOptions> = async (
  app,
  { config, assets },
) => {
  app.get('/', async (_request, reply) => {
    if (!config.landingPage) return reply.redirect('/login');
    const url = new URL('/', config.publicBaseUrl).toString();
    return sendHtml(
      reply,
      renderDocument(<LandingPage url={url} stylesheet={assets.stylesheet} />),
    );
  });
};

/** 404s: an HTML page for browsers, JSON for everything else (including all of /api). */
export function createNotFoundHandler({ config, assets }: PublicPagesOptions) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.code(404);
    const wantsHtml =
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      (request.headers.accept ?? '').includes('text/html');
    if (!wantsHtml) {
      return reply.send({ statusCode: 404, error: 'Not Found', message: 'Route not found' });
    }
    const url = new URL(request.url, config.publicBaseUrl).toString();
    return sendHtml(
      reply,
      renderDocument(<NotFoundPage url={url} stylesheet={assets.stylesheet} />),
    );
  };
}
