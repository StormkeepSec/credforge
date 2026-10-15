import type { VerifyResult } from '@credforge/contracts';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../api/errors';
import type { RateLimiter } from '../api/rate-limit';
import type { Services } from '../services';
import type { DocumentFetcher } from '../verify/fetch';
import { type ParsedVerifyInput, verifyAny } from '../verify/service';
import type { PublicAssets } from './assets';
import { renderDocument } from './document';
import { VerifyPage } from './pages/verify';

/** A baked badge image (images are at most 2 MB) with room for its credential. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Pasted JSON and the other fields. */
const MAX_FIELD_BYTES = 1024 * 1024;

interface FormValues {
  url: string;
  json: string;
  email: string;
  file: Buffer | null;
}

/**
 * `/verify` (design plan §8.5, §9): the public verification page. `GET /verify?url=…` checks a
 * link straight away (so a page can link to its own check); the form posts the address, pasted
 * JSON or a baked image as multipart form data. Shares its rate limit with `POST /api/v1/verify`.
 */
export const publicVerifyRoutes: FastifyPluginAsync<{
  services: Pick<Services, 'db' | 'config'>;
  assets: PublicAssets;
  limiter: RateLimiter;
  fetcher: DocumentFetcher;
}> = async (app, { services: { db, config }, assets, limiter, fetcher }) => {
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5, fieldSize: MAX_FIELD_BYTES, parts: 6 },
  });
  const pageUrl = `${config.publicBaseUrl}/verify`;

  function render(
    reply: FastifyReply,
    status: number,
    props: {
      values: { url: string; json: string };
      error: string | null;
      result: VerifyResult | null;
    },
  ) {
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex');
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .send(renderDocument(<VerifyPage url={pageUrl} stylesheet={assets.stylesheet} {...props} />));
  }

  async function check(request: FastifyRequest, reply: FastifyReply, values: FormValues) {
    const shown = { url: values.url, json: values.json.slice(0, 20_000) };
    const given = [values.url, values.json, values.file?.length ? 'file' : ''].filter(Boolean);
    if (given.length !== 1) {
      return render(reply, 400, {
        values: shown,
        error:
          given.length === 0
            ? 'Give the credential’s address, paste its JSON, or choose a badge image.'
            : 'Give only one of these: the address, the JSON or an image.',
        result: null,
      });
    }
    const allowed = limiter.take(request.ip);
    if (!allowed.allowed) {
      reply.header('retry-after', String(allowed.retryAfter));
      return render(reply, 429, {
        values: shown,
        error: `Too many checks from your network. Wait ${allowed.retryAfter} seconds, then try again.`,
        result: null,
      });
    }
    const input: ParsedVerifyInput = {
      ...(values.url && { url: values.url }),
      ...(values.json && { credential: values.json }),
      ...(values.file?.length && { image: values.file.toString('base64') }),
      ...(values.email && { email: values.email }),
    };
    try {
      const result = await verifyAny({ db, publicBaseUrl: config.publicBaseUrl, fetcher }, input);
      return render(reply, 200, { values: shown, error: null, result });
    } catch (error) {
      if (error instanceof ApiError) {
        return render(reply, error.status, {
          values: shown,
          error: error.detail ?? error.title,
          result: null,
        });
      }
      throw error;
    }
  }

  app.get('/verify', async (request, reply) => {
    const query = request.query as { url?: unknown };
    const url = typeof query.url === 'string' ? query.url.trim().slice(0, 2000) : '';
    if (!url)
      return render(reply, 200, { values: { url: '', json: '' }, error: null, result: null });
    return check(request, reply, { url, json: '', email: '', file: null });
  });

  app.post('/verify', async (request, reply) => {
    const values: FormValues = { url: '', json: '', email: '', file: null };
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const bytes = await part.toBuffer();
          if (part.fieldname === 'file' && bytes.length > 0) values.file = bytes;
        } else if (typeof part.value === 'string') {
          const value = part.value.trim();
          if (part.fieldname === 'url') values.url = value.slice(0, 2000);
          else if (part.fieldname === 'json') values.json = value;
          else if (part.fieldname === 'email') values.email = value.slice(0, 254);
        }
      }
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      const tooLarge =
        /LIMIT|TOO_LARGE/.test(code) || (error as { statusCode?: number }).statusCode === 413;
      return render(reply, tooLarge ? 413 : 400, {
        values: { url: values.url, json: '' },
        error: tooLarge
          ? 'That is too large to check: images can be at most 4 MB.'
          : 'The form couldn’t be read. Try again.',
        result: null,
      });
    }
    return check(request, reply, values);
  });
};
