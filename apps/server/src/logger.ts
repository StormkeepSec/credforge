import type { LoggerOptions } from 'pino';
import type { Config } from './config';

/**
 * Query parameters that carry secrets or personal data: claim links, reset and confirmation links,
 * OAuth callbacks, the address checked with /verify (never logged, §8.5) and prefilled emails.
 */
const SECRET_PARAMS = new Set(['t', 'token', 'code', 'state', 'url', 'email']);
/** Paths whose next segment is a secret: invitation links. */
const SECRET_PATH = /^(\/invite\/|\/api\/v1\/invitations\/)([^/?#]+)/;

/**
 * A request URL fit for the log (design plan §14: no secrets): the tokens in claim links
 * (`?t=`), password-reset and email-confirmation links (`?token=`), OAuth callbacks
 * (`?code=&state=`), invitation links (`/invite/{token}`), the address checked with `/verify?url=`
 * and prefilled email addresses are replaced.
 */
export function redactUrl(url: string): string {
  const [path = '', query] = url.split('?', 2) as [string, string | undefined];
  const safePath = path.replace(SECRET_PATH, '$1[redacted]');
  if (query === undefined) return safePath;
  const params = query.split('&').map((pair) => {
    const raw = pair.split('=', 1)[0] ?? '';
    let name = raw;
    try {
      name = decodeURIComponent(raw);
    } catch {
      // Malformed escapes: compare as written.
    }
    return SECRET_PARAMS.has(name) ? `${pair.split('=', 1)[0]}=[redacted]` : pair;
  });
  return `${safePath}?${params.join('&')}`;
}

export function loggerOptions(config: Pick<Config, 'env' | 'logLevel'>): LoggerOptions {
  return {
    level: config.logLevel,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
    serializers: {
      // Fastify's request serializer, with secrets taken out of the URL.
      req(request: {
        method?: string;
        url?: string;
        host?: string;
        ip?: string;
        socket?: { remotePort?: number };
      }) {
        return {
          method: request.method,
          url: request.url === undefined ? undefined : redactUrl(request.url),
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        };
      },
    },
    ...(config.env === 'development' && {
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    }),
  };
}
