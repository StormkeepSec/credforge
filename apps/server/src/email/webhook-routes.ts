import type { FastifyPluginAsync } from 'fastify';
import { createRateLimiter } from '../api/rate-limit';
import type { Services } from '../services';
import {
  type SendGridEvent,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySendGridSignature,
} from './sendgrid';
import { applySendGridEvents } from './tracking';

/**
 * `/api/webhooks/sendgrid`: SendGrid's signed Event Webhook (design plan §8.4). Every request's
 * ECDSA signature is checked against SENDGRID_WEBHOOK_PUBLIC_KEY before any event is trusted;
 * without that key the endpoint doesn't exist. Delivered, bounce, dropped and spam-report events
 * update the award emails' delivery status.
 */
export const sendgridWebhookRoutes: FastifyPluginAsync<{
  services: Pick<Services, 'db' | 'config'>;
}> = async (app, { services: { db, config } }) => {
  const publicKey = config.email.sendgridWebhookPublicKey;
  if (!publicKey) return;

  // Requests with a bad signature, per client IP: SendGrid's own requests are never limited,
  // but someone posting junk is turned away before more signature checks.
  const rejected = createRateLimiter({ max: 20, windowMs: 60_000 });

  // The signature covers the body exactly as sent, so keep the raw bytes.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );

  app.post('/api/webhooks/sendgrid', async (request, reply) => {
    if (rejected.peek(`webhook:${request.ip}`) === 'limited') {
      return reply.code(429).header('retry-after', '60').send({ error: 'too many bad requests' });
    }
    const raw = request.body;
    const signature = request.headers[SIGNATURE_HEADER];
    const timestamp = request.headers[TIMESTAMP_HEADER];
    if (
      !Buffer.isBuffer(raw) ||
      !verifySendGridSignature(
        publicKey,
        raw,
        typeof signature === 'string' ? signature : undefined,
        typeof timestamp === 'string' ? timestamp : undefined,
      )
    ) {
      request.log.warn('SendGrid webhook: bad or missing signature');
      rejected.take(`webhook:${request.ip}`);
      return reply.code(403).send({ error: 'invalid signature' });
    }

    let events: unknown;
    try {
      events = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'invalid JSON' });
    }
    if (!Array.isArray(events)) return reply.code(400).send({ error: 'expected an array' });
    const applied = await applySendGridEvents(db, events as SendGridEvent[]);
    request.log.info({ received: events.length, applied }, 'SendGrid events');
    return reply.code(204).send();
  });
};
