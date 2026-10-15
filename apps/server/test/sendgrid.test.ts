import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { awardMessage } from '../src/email/messages';
import {
  createSendGridTransport,
  SENDGRID_MAIL_SEND_URL,
  sendGridRequest,
  verifySendGridSignature,
} from '../src/email/sendgrid';
import { PermanentEmailError } from '../src/email/transport';

const fixtures = join(import.meta.dirname, 'fixtures/sendgrid');
const from = { name: 'credforge', address: 'awards@credforge.app' };

const message = awardMessage({
  to: 'jordan@example.org',
  recipientName: 'Jordan Rivera',
  issuerName: 'Example Cyber Academy',
  issuerEmail: 'badges@example.org',
  achievementName: 'Intro to Network Defense',
  achievementDescription: 'Recognizes foundational skills.',
  imageUrl: 'https://credforge.app/achievements/a/images/b-512.png',
  claimUrl: 'https://credforge.app/credentials/c?t=token',
  claimExpiresAt: new Date('2027-01-31T00:00:00Z'),
  serviceName: 'credforge',
  trackingId: '8f0c2d4e-6b1a-4c3d-9e2f-1a2b3c4d5e6f',
});

describe('SendGrid Mail Send requests', () => {
  it('sends as "{issuer} via credforge" from credforge’s address, replies to the issuer', () => {
    const body = sendGridRequest(message, from);
    expect(body.from).toEqual({
      email: 'awards@credforge.app',
      name: 'Example Cyber Academy via credforge',
    });
    expect(body.reply_to).toEqual({ email: 'badges@example.org' });
    expect(body.personalizations).toEqual([
      {
        to: [{ email: 'jordan@example.org' }],
        custom_args: { credforge_email_id: '8f0c2d4e-6b1a-4c3d-9e2f-1a2b3c4d5e6f' },
      },
    ]);
    expect(body.subject).toBe('Example Cyber Academy awarded you Intro to Network Defense');
    expect(body.content.map((part) => part.type)).toEqual(['text/plain', 'text/html']);
    expect(body.categories).toEqual(['award']);
  });

  it('turns off click and open tracking, so claim links never go through SendGrid', () => {
    expect(sendGridRequest(message, from).tracking_settings).toEqual({
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
      ganalytics: { enable: false },
    });
  });

  it('keeps header-breaking characters out of the display name', () => {
    const body = sendGridRequest({ ...message, fromName: 'Evil\r\nBcc: x@y.z "<>' }, from);
    expect(body.from.name).toBe('Evil Bcc: x@y.z');
  });
});

describe('the SendGrid transport', () => {
  function transport(status: number, body = '', headers: Record<string, string> = {}) {
    const requests: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(body || null, { status, headers });
    }) as unknown as typeof fetch;
    return { requests, send: createSendGridTransport({ apiKey: 'SG.key', from }, fake) };
  }

  it('posts to the v3 Mail Send API and returns X-Message-Id', async () => {
    const { requests, send } = transport(202, '', { 'x-message-id': '14c5d75ce93.dfd.64b469' });
    expect(await send.send(message)).toEqual({ messageId: '14c5d75ce93.dfd.64b469' });
    expect(requests[0]?.url).toBe(SENDGRID_MAIL_SEND_URL);
    expect(requests[0]?.init.headers).toMatchObject({ authorization: 'Bearer SG.key' });
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual(sendGridRequest(message, from));
  });

  it('gives up on a refused message, and retries the rest', async () => {
    const refused = transport(
      400,
      JSON.stringify({
        errors: [{ message: 'Does not contain a valid address.', field: 'personalizations.0.to' }],
      }),
    );
    await expect(refused.send.send(message)).rejects.toThrow(PermanentEmailError);
    await expect(refused.send.send(message)).rejects.toThrow('Does not contain a valid address');
    for (const status of [401, 429, 500, 503]) {
      const error = await transport(status)
        .send.send(message)
        .catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(Error);
      expect(error, String(status)).not.toBeInstanceOf(PermanentEmailError);
    }
  });
});

describe('Event Webhook signatures', () => {
  const vector = JSON.parse(readFileSync(join(fixtures, 'signature.json'), 'utf8')) as {
    publicKey: string;
    timestamp: string;
    signature: string;
  };
  const body = readFileSync(join(fixtures, 'events.json'));

  it('accepts the recorded request', () => {
    expect(
      verifySendGridSignature(vector.publicKey, body, vector.signature, vector.timestamp),
    ).toBe(true);
  });

  it('rejects any change to the body, timestamp or signature', () => {
    const changed = Buffer.from(body.toString().replace('delivered', 'bounce'));
    expect(
      verifySendGridSignature(vector.publicKey, changed, vector.signature, vector.timestamp),
    ).toBe(false);
    expect(
      verifySendGridSignature(vector.publicKey, body, vector.signature, `${vector.timestamp}0`),
    ).toBe(false);
    expect(verifySendGridSignature(vector.publicKey, body, 'AAAA', vector.timestamp)).toBe(false);
    expect(verifySendGridSignature(vector.publicKey, body, undefined, vector.timestamp)).toBe(
      false,
    );
    expect(verifySendGridSignature(vector.publicKey, body, vector.signature, undefined)).toBe(
      false,
    );
    // Re-serialized JSON is a different body: the raw bytes must be used.
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString())));
    expect(
      verifySendGridSignature(vector.publicKey, reserialized, vector.signature, vector.timestamp),
    ).toBe(false);
  });

  it('accepts the key as PEM too', async () => {
    const { createPublicKey } = await import('node:crypto');
    const pem = createPublicKey({
      key: Buffer.from(vector.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    })
      .export({ format: 'pem', type: 'spki' })
      .toString();
    expect(verifySendGridSignature(pem, body, vector.signature, vector.timestamp)).toBe(true);
  });
});

describe('the award email', () => {
  it('escapes everything that came from users', () => {
    const evil = awardMessage({
      to: 'x@example.org',
      recipientName: '<b>Jordan</b>',
      issuerName: 'Acme <script>',
      issuerEmail: null,
      achievementName: '"><img src=x onerror=alert(1)>',
      achievementDescription: 'A & B',
      imageUrl: 'https://credforge.app/a"b.png',
      claimUrl: 'https://credforge.app/credentials/c?t=token',
      claimExpiresAt: new Date('2027-01-31T00:00:00Z'),
      serviceName: 'credforge',
    });
    expect(evil.html).not.toMatch(/<script>|<b>|<img src=x/);
    expect(evil.html).toContain('&lt;b&gt;Jordan&lt;/b&gt;');
    expect(evil.html).toContain('a&quot;b.png');
    expect(evil.replyTo).toBeUndefined();
    expect(evil.text).toContain('Contact Acme <script>');
  });

  it('says how long the link works and not to share it', () => {
    expect(message.text).toContain('works until January 31, 2027');
    expect(message.text).toContain('use the address of its page instead');
    expect(message.text).toContain('https://credforge.app/credentials/c?t=token');
  });
});
