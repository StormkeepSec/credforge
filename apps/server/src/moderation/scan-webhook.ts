import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type CategoryScores,
  type ImageModerator,
  type KnownCsamMatch,
  type KnownCsamMatcher,
  parseScores,
  ScanError,
  type TextModerator,
} from './scanners';

/**
 * The generic webhook (design plan §6.5, decision 60; the contract is in
 * docs/moderation-webhooks.md). credforge POSTs the content as JSON to the operator's URL, signed
 * with HMAC-SHA256 under a shared secret, and reads category scores (a classifier) or a match (a
 * known-CSAM matcher) from the answer. A hosted service or a self-hosted model plugs in behind a
 * small adapter of the operator's, with no change to credforge.
 */

export const SIGNATURE_HEADER = 'credforge-signature';
export const REQUEST_ID_HEADER = 'credforge-request-id';
/** How old a signed request may be when it arrives (receivers should refuse older ones). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
/** The webhook protocol version, in every request body. */
export const WEBHOOK_VERSION = 1;

const ANSWER_LIMIT_BYTES = 64 * 1024;

/** `t={unix seconds},v1={hex HMAC-SHA256 of "{t}.{body}"}`. */
export function signatureHeader(secret: string, body: string, now = new Date()): string {
  const timestamp = Math.floor(now.getTime() / 1000);
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

/**
 * Checks a signature header against the raw body, as a receiver does: the MAC must match and the
 * timestamp be within the tolerance. For operators writing a receiver in Node, and for the tests.
 */
export function verifySignature(
  secret: string,
  header: string | undefined,
  body: string,
  now = new Date(),
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  const parts = new Map(
    (header ?? '').split(',').map((part) => {
      const equals = part.indexOf('=');
      return [part.slice(0, equals).trim(), part.slice(equals + 1).trim()] as const;
    }),
  );
  const timestamp = Number(parts.get('t'));
  const given = parts.get('v1') ?? '';
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(given)) return false;
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  return timingSafeEqual(expected, Buffer.from(given, 'hex'));
}

export interface WebhookTarget {
  url: string;
  secret: string;
  /** Who runs the service, as the queue and the privacy policy name it. */
  name: string;
}

export interface WebhookOptions {
  /** Sent as the User-Agent, e.g. `credforge (+https://credforge.app)`. */
  userAgent: string;
  timeoutMs?: number;
  /** Stands in for the global fetch in tests. */
  fetch?: typeof fetch;
}

/** POSTs a signed JSON body and returns the parsed JSON answer; ScanError for anything else. */
export async function postSigned(
  target: WebhookTarget,
  requestId: string,
  payload: Record<string, unknown>,
  options: WebhookOptions,
): Promise<unknown> {
  const body = JSON.stringify(payload);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': options.userAgent,
        [SIGNATURE_HEADER]: signatureHeader(target.secret, body),
        [REQUEST_ID_HEADER]: requestId,
      },
      body,
      // The URL is the operator's: never follow a redirect elsewhere with the content.
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (error) {
    throw new ScanError(`${target.name} couldn’t be reached.`, { cause: error });
  }
  const text = await readLimited(response);
  if (!response.ok) {
    throw new ScanError(`${target.name} answered ${response.status}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ScanError(`${target.name} didn’t answer JSON.`);
  }
}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ANSWER_LIMIT_BYTES) {
      await reader.cancel();
      throw new ScanError('The scanner’s answer is larger than 64 KB.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A classifier behind the webhook: `{"categories": {"name": score, …}}` for images and text. */
export function createWebhookModerator(
  target: WebhookTarget,
  options: WebhookOptions,
): ImageModerator & TextModerator {
  const scores = (answer: unknown): CategoryScores =>
    parseScores((answer as { categories?: unknown } | null)?.categories, target.name);
  return {
    name: target.name,
    async scanImage(image, context) {
      const answer = await postSigned(
        target,
        context.requestId,
        {
          version: WEBHOOK_VERSION,
          id: context.requestId,
          type: 'image',
          subject: context.subject,
          image: {
            mimeType: 'image/png',
            width: image.width,
            height: image.height,
            data: image.png.toString('base64'),
          },
        },
        options,
      );
      return scores(answer);
    },
    async scanText(text, context) {
      const answer = await postSigned(
        target,
        context.requestId,
        {
          version: WEBHOOK_VERSION,
          id: context.requestId,
          type: 'text',
          subject: context.subject,
          text: { fields: text.fields, joined: joinFields(text.fields) },
        },
        options,
      );
      return scores(answer);
    },
  };
}

/** A known-CSAM matcher behind the webhook: `{"matched": false}` or `{"matched": true, …}`. */
export function createWebhookCsamMatcher(
  target: WebhookTarget,
  options: WebhookOptions,
): KnownCsamMatcher {
  return {
    name: target.name,
    async match(image, context) {
      const answer = (await postSigned(
        target,
        context.requestId,
        {
          version: WEBHOOK_VERSION,
          id: context.requestId,
          type: 'csam_match',
          subject: context.subject,
          image: {
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
            sha256: image.sha256,
            data: image.bytes.toString('base64'),
          },
        },
        options,
      )) as { matched?: unknown; list?: unknown; reference?: unknown } | null;
      if (typeof answer?.matched !== 'boolean') {
        throw new ScanError(`${target.name} answered without "matched".`);
      }
      if (!answer.matched) return null;
      const match: KnownCsamMatch = {};
      if (typeof answer.list === 'string' && answer.list) match.list = answer.list.slice(0, 200);
      if (typeof answer.reference === 'string' && answer.reference) {
        match.reference = answer.reference.slice(0, 500);
      }
      return match;
    },
  };
}

/** The text fields as one text, one field per paragraph, for scanners that read a single text. */
export function joinFields(fields: { name: string; value: string }[]): string {
  return fields.map((field) => field.value).join('\n\n');
}
