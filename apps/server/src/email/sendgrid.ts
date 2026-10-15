import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import type { Mailbox } from '../config';
import { type EmailMessage, type EmailTransport, PermanentEmailError, senderOf } from './transport';

/**
 * SendGrid's v3 Mail Send API (design plan §8.4). Click, open and subscription tracking are
 * turned off on every message: links carry tokens (claim links, verification links) that must
 * never pass through SendGrid's redirect domain, and "opened" is recorded first-party when the
 * recipient visits their claim link.
 */

export const SENDGRID_MAIL_SEND_URL = 'https://api.sendgrid.com/v3/mail/send';

/** The custom argument that ties webhook events back to an `email_message` row. */
export const TRACKING_ARG = 'credforge_email_id';

/** The request body for one message. */
export function sendGridRequest(message: EmailMessage, from: Mailbox) {
  const sender = senderOf(from, message);
  return {
    personalizations: [
      {
        to: [{ email: message.to }],
        ...(message.trackingId && { custom_args: { [TRACKING_ARG]: message.trackingId } }),
      },
    ],
    from: sender.name ? { email: sender.address, name: sender.name } : { email: sender.address },
    ...(message.replyTo && { reply_to: { email: message.replyTo } }),
    subject: message.subject,
    content: [
      { type: 'text/plain', value: message.text },
      { type: 'text/html', value: message.html },
    ],
    categories: [message.kind],
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
      ganalytics: { enable: false },
    },
  };
}

type Fetch = typeof fetch;

export function createSendGridTransport(
  options: { apiKey: string; from: Mailbox; url?: string },
  fetchImpl: Fetch = fetch,
): EmailTransport {
  const url = options.url ?? SENDGRID_MAIL_SEND_URL;
  return {
    name: 'sendgrid',
    async send(message) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(sendGridRequest(message, options.from)),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        // 202 Accepted. X-Message-Id is the prefix of every event's sg_message_id.
        return { messageId: response.headers.get('x-message-id') ?? undefined };
      }
      const detail = await errorDetail(response);
      // 400 and 413 won't succeed on a retry. 401/403 (a key problem) and 429/5xx are retried, so
      // an operator who fixes the key within the retry window loses nothing.
      if (response.status === 400 || response.status === 413) {
        throw new PermanentEmailError(
          `SendGrid refused the message (${response.status}): ${detail}`,
        );
      }
      throw new Error(`SendGrid answered ${response.status}: ${detail}`);
    },
  };
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { errors?: { message?: string; field?: string | null }[] };
    const messages = (body.errors ?? [])
      .map((error) => [error.field, error.message].filter(Boolean).join(': '))
      .filter(Boolean);
    if (messages.length > 0) return messages.join('; ').slice(0, 500);
  } catch {
    // not JSON
  }
  return text.slice(0, 500) || response.statusText;
}

// ---- Event Webhook ----

export const SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
export const TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';

const keys = new Map<string, KeyObject>();

/** SendGrid's verification key: base64 DER (as its settings page shows it) or PEM. */
export function sendGridPublicKey(value: string): KeyObject {
  let key = keys.get(value);
  if (!key) {
    key = value.includes('BEGIN PUBLIC KEY')
      ? createPublicKey(value)
      : createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
    keys.set(value, key);
  }
  return key;
}

/**
 * Checks a signed Event Webhook request: an ECDSA P-256 / SHA-256 signature (base64 DER) over the
 * timestamp header followed by the raw request body, exactly as received.
 */
export function verifySendGridSignature(
  publicKey: string,
  rawBody: Buffer,
  signature: string | undefined,
  timestamp: string | undefined,
): boolean {
  if (!signature || !timestamp) return false;
  try {
    return verify(
      'sha256',
      Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]),
      sendGridPublicKey(publicKey),
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/** The fields credforge reads from one webhook event. */
export interface SendGridEvent {
  event: string;
  email?: string;
  timestamp?: number;
  sg_event_id?: string;
  sg_message_id?: string;
  reason?: string;
  type?: string;
  [TRACKING_ARG]?: string;
}
