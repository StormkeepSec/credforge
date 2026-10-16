import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { PublicAssets } from './assets';
import { renderDocument } from './document';
import { LandingPage } from './pages/landing';
import { type LegalFacts, PrivacyPage, TermsPage } from './pages/legal';
import { NotFoundPage } from './pages/not-found';

export interface PublicPagesOptions {
  config: Pick<
    Config,
    | 'publicBaseUrl'
    | 'landingPage'
    | 'signupMode'
    | 'requireMfaForAdmins'
    | 'operatorName'
    | 'privacyEmail'
    | 'abuseEmail'
    | 'securityEmail'
    | 'legalPagesDraft'
    | 'email'
    | 'storage'
    | 'oauth'
  >;
  assets: PublicAssets;
}

function sendHtml(reply: FastifyReply, html: string) {
  return reply.type('text/html; charset=utf-8').send(html);
}

/** What the privacy policy and terms can say for sure about this instance (its configuration). */
export function legalFacts(config: PublicPagesOptions['config']): LegalFacts {
  const storage = config.storage;
  const onSpaces =
    storage.driver === 's3' && (storage.endpoint ?? '').includes('digitaloceanspaces.com');
  return {
    siteName: new URL(config.publicBaseUrl).host,
    publicBaseUrl: config.publicBaseUrl,
    operatorName: config.operatorName,
    privacyEmail: config.privacyEmail,
    abuseEmail: config.abuseEmail,
    securityEmail: config.securityEmail,
    draft: config.legalPagesDraft,
    signupMode: config.signupMode,
    requireMfaForAdmins: config.requireMfaForAdmins,
    providers: {
      email: config.email.transport,
      storage: onSpaces ? 'digitalocean' : storage.driver,
      storageRegion: storage.driver === 's3' ? storage.region : null,
      google: Boolean(config.oauth.google),
      microsoft: Boolean(config.oauth.microsoft),
    },
  };
}

/** Server-rendered public pages: the landing page, privacy policy and terms. */
export const publicPages: FastifyPluginAsync<PublicPagesOptions> = async (
  app,
  { config, assets },
) => {
  const pageUrl = (path: string) => new URL(path, config.publicBaseUrl).toString();

  app.get('/', async (_request, reply) => {
    if (!config.landingPage) return reply.redirect('/login');
    return sendHtml(
      reply,
      renderDocument(
        <LandingPage
          url={pageUrl('/')}
          stylesheet={assets.stylesheet}
          signupMode={config.signupMode}
          requireMfaForAdmins={config.requireMfaForAdmins}
        />,
      ),
    );
  });

  app.get('/privacy', async (_request, reply) =>
    sendHtml(
      reply,
      renderDocument(
        <PrivacyPage
          url={pageUrl('/privacy')}
          stylesheet={assets.stylesheet}
          facts={legalFacts(config)}
        />,
      ),
    ),
  );

  app.get('/terms', async (_request, reply) =>
    sendHtml(
      reply,
      renderDocument(
        <TermsPage
          url={pageUrl('/terms')}
          stylesheet={assets.stylesheet}
          facts={legalFacts(config)}
        />,
      ),
    ),
  );

  /** RFC 9116: where to report vulnerabilities (SECURITY_EMAIL). */
  app.get('/.well-known/security.txt', async (_request, reply) => {
    if (!config.securityEmail) return reply.callNotFound();
    const expires = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
    expires.setUTCHours(0, 0, 0, 0);
    return reply
      .type('text/plain; charset=utf-8')
      .header('cache-control', 'public, max-age=86400')
      .send(
        [
          `Contact: mailto:${config.securityEmail}`,
          `Expires: ${expires.toISOString()}`,
          'Preferred-Languages: en',
          `Canonical: ${pageUrl('/.well-known/security.txt')}`,
          '',
        ].join('\n'),
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
