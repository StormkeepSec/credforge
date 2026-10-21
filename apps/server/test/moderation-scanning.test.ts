import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import {
  EvidenceError,
  keyFingerprint,
  openEvidence,
  parseEvidencePublicKey,
  readEnvelope,
  sealEvidence,
} from '../src/moderation/evidence';
import { createScanners } from '../src/moderation/scan';
import { createOpenAiModerator, OPENAI_MODERATION_URL } from '../src/moderation/scan-openai';
import {
  createWebhookCsamMatcher,
  createWebhookModerator,
  SIGNATURE_HEADER,
  signatureHeader,
  verifySignature,
} from '../src/moderation/scan-webhook';
import { ScanError } from '../src/moderation/scanners';
import { imageWithheld } from '../src/moderation/service';
import { decide, parseCategoryThresholds, type Thresholds } from '../src/moderation/thresholds';

// The automatic check and known-CSAM matching (design plan §6.5, decisions 60–61). Every provider,
// threshold and key here is made up for the tests: credforge ships none.

const SECRET = 'credforge-test-secret-0123456789abcdef';
const CONTEXT = {
  requestId: '7d1c2a51-1111-4c3e-9a8a-3d5e6f708192',
  subject: 'badge_image' as const,
};
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('webhook signatures', () => {
  it('signs "{timestamp}.{body}" with HMAC-SHA256 (a fixed vector: the contract)', () => {
    const body = '{"version":1,"id":"x"}';
    expect(signatureHeader(SECRET, body, new Date(1_792_600_000_000))).toBe(
      't=1792600000,v1=1634bd3b20d96369b096ff1d13186b53466bc25de7b45c38e70bf0aa2e0992c4',
    );
  });

  it('verifies the body, the secret and the age, as a receiver should', () => {
    const now = new Date('2026-10-21T12:00:00Z');
    const body = JSON.stringify({ version: 1, type: 'text' });
    const header = signatureHeader(SECRET, body, now);
    expect(verifySignature(SECRET, header, body, now)).toBe(true);
    expect(verifySignature(SECRET, header, `${body} `, now)).toBe(false);
    expect(verifySignature(`${SECRET}x`, header, body, now)).toBe(false);
    // Five minutes either way, no more.
    expect(verifySignature(SECRET, header, body, new Date(now.getTime() + 299_000))).toBe(true);
    expect(verifySignature(SECRET, header, body, new Date(now.getTime() + 301_000))).toBe(false);
    for (const broken of [
      undefined,
      '',
      't=1',
      'v1=abc',
      't=x,v1=00',
      `t=1,v1=${'0'.repeat(63)}`,
    ]) {
      expect(verifySignature(SECRET, broken, body, now), String(broken)).toBe(false);
    }
  });
});

/** A local stand-in for the operator's service: records requests, answers what the test says. */
function stubService() {
  const requests: { headers: IncomingMessage['headers']; body: string }[] = [];
  let answer: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) =>
    response.writeHead(204).end();
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ headers: request.headers, body });
      answer(request, response);
    });
  });
  return {
    requests,
    server,
    answer(next: typeof answer) {
      answer = next;
    },
    json(status: number, value: unknown) {
      answer = (_request, response) =>
        response
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(value));
    },
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/check`,
  };
}

describe('the webhook classifier and matcher', () => {
  const service = stubService();
  beforeAll(async () => {
    await new Promise<void>((done) => service.server.listen(0, '127.0.0.1', done));
  });
  afterAll(async () => {
    await new Promise((done) => service.server.close(done));
  });
  const target = () => ({ url: service.url(), secret: SECRET, name: 'Test classifier' });
  const options = { userAgent: 'credforge (+https://credforge.test)', timeoutMs: 2_000 };

  it('posts a signed image and reads its category scores', async () => {
    service.json(200, { categories: { Sexual: 0.91, violence: 0.2, 'self-harm': null } });
    const scores = await createWebhookModerator(target(), options).scanImage(
      { png: PNG, width: 512, height: 512 },
      CONTEXT,
    );
    expect(scores).toEqual({ sexual: 0.91, violence: 0.2 });
    const request = service.requests.at(-1);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.headers['user-agent']).toBe(options.userAgent);
    expect(request?.headers['credforge-request-id']).toBe(CONTEXT.requestId);
    expect(
      verifySignature(SECRET, request?.headers[SIGNATURE_HEADER] as string, request?.body ?? ''),
    ).toBe(true);
    expect(JSON.parse(request?.body ?? '')).toEqual({
      version: 1,
      id: CONTEXT.requestId,
      type: 'image',
      subject: 'badge_image',
      image: { mimeType: 'image/png', width: 512, height: 512, data: PNG.toString('base64') },
    });
  });

  it('posts text field by field and joined', async () => {
    service.json(200, { categories: { hate: 0.7 } });
    const fields = [
      { name: 'name', value: 'A name' },
      { name: 'description', value: 'A description' },
    ];
    expect(
      await createWebhookModerator(target(), options).scanText(
        { fields },
        { ...CONTEXT, subject: 'achievement' },
      ),
    ).toEqual({ hate: 0.7 });
    expect(JSON.parse(service.requests.at(-1)?.body ?? '')).toMatchObject({
      type: 'text',
      subject: 'achievement',
      text: { fields, joined: 'A name\n\nA description' },
    });
  });

  it('fails the check on anything but a valid answer', async () => {
    const moderator = createWebhookModerator(target(), options);
    const scan = () => moderator.scanText({ fields: [{ name: 'name', value: 'x' }] }, CONTEXT);
    for (const [status, body] of [
      [500, { categories: {} }],
      [200, { scores: {} }],
      [200, { categories: { sexual: 1.5 } }],
      [200, { categories: { sexual: '0.5' } }],
      [200, { categories: { 'Bad Name!': 0.5 } }],
      [200, { categories: [0.5] }],
    ] as const) {
      service.json(status, body);
      await expect(scan(), JSON.stringify(body)).rejects.toBeInstanceOf(ScanError);
    }
    service.answer((_request, response) => response.writeHead(200).end('not json'));
    await expect(scan()).rejects.toThrow('didn’t answer JSON');
    service.answer((_request, response) => response.writeHead(200).end('x'.repeat(70_000)));
    await expect(scan()).rejects.toThrow('larger than 64 KB');
    // The content never follows a redirect to another address.
    service.answer((_request, response) =>
      response.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' }).end(),
    );
    await expect(scan()).rejects.toThrow('couldn’t be reached');
    service.answer(() => {
      // Never answers.
    });
    await expect(
      createWebhookModerator(target(), { ...options, timeoutMs: 200 }).scanText(
        { fields: [{ name: 'name', value: 'x' }] },
        CONTEXT,
      ),
    ).rejects.toThrow('couldn’t be reached');
  });

  it('asks the matcher with the image and its hash, and reads a match', async () => {
    const matcher = createWebhookCsamMatcher({ ...target(), name: 'Test matcher' }, options);
    const image = {
      bytes: PNG,
      mimeType: 'image/png' as const,
      width: 64,
      height: 64,
      sha256: 'ab'.repeat(32),
    };
    service.json(200, { matched: false });
    expect(await matcher.match(image, CONTEXT)).toBeNull();
    expect(JSON.parse(service.requests.at(-1)?.body ?? '')).toMatchObject({
      type: 'csam_match',
      image: { sha256: image.sha256, data: PNG.toString('base64') },
    });
    service.json(200, { matched: true, list: 'Test list', reference: 'ref-1' });
    expect(await matcher.match(image, CONTEXT)).toEqual({ list: 'Test list', reference: 'ref-1' });
    service.json(200, { matched: true });
    expect(await matcher.match(image, CONTEXT)).toEqual({});
    service.json(200, { match: null });
    await expect(matcher.match(image, CONTEXT)).rejects.toThrow('without "matched"');
  });
});

describe('the OpenAI adapter', () => {
  function fakeFetch(answer: { status: number; body: unknown }) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  }
  const result = {
    results: [
      {
        category_scores: { sexual: 0.8, 'sexual/minors': 0, hate: 0, violence: 0.1 },
        category_applied_input_types: {
          sexual: ['image'],
          'sexual/minors': [],
          hate: [],
          violence: ['image'],
        },
      },
    ],
  };

  it('sends an image as a data URL and leaves out categories it didn’t score for images', async () => {
    const { calls, fetch } = fakeFetch({ status: 200, body: result });
    const moderator = createOpenAiModerator({
      apiKey: 'test-key',
      model: 'omni-moderation-latest',
      userAgent: 'credforge (+https://credforge.test)',
      fetch,
    });
    expect(await moderator.scanImage({ png: PNG, width: 512, height: 512 }, CONTEXT)).toEqual({
      sexual: 0.8,
      violence: 0.1,
    });
    expect(calls[0]?.url).toBe(OPENAI_MODERATION_URL);
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      'Bearer test-key',
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: 'omni-moderation-latest',
      input: [
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` },
        },
      ],
    });
  });

  it('sends text as one input, and fails on errors', async () => {
    const text = fakeFetch({
      status: 200,
      body: { results: [{ category_scores: { hate: 0.6, sexual: 0.01 } }] },
    });
    const moderator = createOpenAiModerator({
      apiKey: 'test-key',
      model: 'omni-moderation-latest',
      userAgent: 'credforge',
      fetch: text.fetch,
    });
    expect(
      await moderator.scanText(
        {
          fields: [
            { name: 'name', value: 'A' },
            { name: 'description', value: 'B' },
          ],
        },
        CONTEXT,
      ),
    ).toEqual({ hate: 0.6, sexual: 0.01 });
    expect(JSON.parse(String(text.calls[0]?.init.body)).input).toBe('A\n\nB');

    for (const answer of [
      { status: 429, body: { error: { message: 'slow down' } } },
      { status: 200, body: { results: [] } },
    ]) {
      const failing = createOpenAiModerator({
        apiKey: 'k',
        model: 'm',
        userAgent: 'credforge',
        fetch: fakeFetch(answer).fetch,
      });
      await expect(
        failing.scanText({ fields: [{ name: 'n', value: 'x' }] }, CONTEXT),
      ).rejects.toBeInstanceOf(ScanError);
    }
  });
});

describe('thresholds', () => {
  const thresholds: Thresholds = {
    hold: 0.5,
    remove: null,
    categories: parseCategoryThresholds('sexual/minors=0.05:0.4, violence=0.8, Harassment=off'),
  };

  it('parses category=hold[:remove], with off', () => {
    expect(thresholds.categories).toEqual({
      'sexual/minors': { hold: 0.05, remove: 0.4 },
      violence: { hold: 0.8 },
      harassment: { hold: null },
    });
    expect(parseCategoryThresholds('')).toEqual({});
    expect(parseCategoryThresholds(undefined)).toEqual({});
    expect(parseCategoryThresholds('hate=0.3:off')).toEqual({ hate: { hold: 0.3, remove: null } });
    for (const bad of [
      'hate',
      'hate=0',
      'hate=1.5',
      'hate=0.5:0.6:0.7',
      'Hat e=0.5',
      'a=0.1,a=0.2',
      'x=abc',
    ]) {
      expect(() => parseCategoryThresholds(bad), bad).toThrow();
    }
  });

  it('holds at or over a category’s hold threshold and removes at or over its remove threshold', () => {
    expect(decide(thresholds, { sexual: 0.49, violence: 0.79, harassment: 0.99 })).toEqual({
      hold: [],
      remove: [],
    });
    expect(decide(thresholds, { sexual: 0.5, violence: 0.8 })).toEqual({
      hold: ['violence', 'sexual'],
      remove: [],
    });
    expect(decide(thresholds, { 'sexual/minors': 0.06 })).toEqual({
      hold: ['sexual/minors'],
      remove: [],
    });
    expect(decide(thresholds, { 'sexual/minors': 0.4, sexual: 0.9 })).toEqual({
      hold: ['sexual', 'sexual/minors'],
      remove: ['sexual/minors'],
    });
    // A default remove threshold applies to every category without its own.
    expect(decide({ ...thresholds, remove: 0.95 }, { hate: 0.97, violence: 0.96 })).toEqual({
      hold: ['hate', 'violence'],
      remove: ['hate', 'violence'],
    });
  });
});

describe('sealed evidence', () => {
  let publicKey: KeyObject;
  let privateKey: KeyObject;
  let otherPrivateKey: KeyObject;
  beforeAll(() => {
    ({ publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 }));
    ({ privateKey: otherPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 }));
  });
  const marker = Buffer.from('UNIQUE-IMAGE-BYTES-0123456789');
  const bundle = () => ({
    manifest: { evidenceId: 'e1', uploader: { email: 'uploader@example.org' } },
    files: [{ name: 'original.png', mimeType: 'image/png', bytes: Buffer.concat([PNG, marker]) }],
  });

  it('opens with the private key only, intact, and hides the content', () => {
    const id = 'c0ffee00-0000-4000-8000-000000000001';
    const stored = sealEvidence(publicKey, id, bundle());
    const text = stored.toString('utf8');
    for (const secret of [marker.toString(), marker.toString('base64'), 'uploader@example.org']) {
      expect(text).not.toContain(secret);
    }
    expect(readEnvelope(stored)).toMatchObject({
      format: 'credforge-evidence',
      id,
      alg: 'RSA-OAEP-256+A256GCM',
      keyFingerprint: keyFingerprint(publicKey),
    });
    const opened = openEvidence(privateKey, stored);
    expect(opened.manifest).toEqual(bundle().manifest);
    expect(opened.files[0]?.bytes.equals(bundle().files[0]?.bytes as Buffer)).toBe(true);

    expect(() => openEvidence(otherPrivateKey, stored)).toThrow('sealed to another key');
    const envelope = JSON.parse(text);
    // Moved to another id (the key binds the ciphertext to its id), or changed.
    const moved = Buffer.from(
      JSON.stringify({ ...envelope, id: 'c0ffee00-0000-4000-8000-000000000002' }),
    );
    expect(() => openEvidence(privateKey, moved)).toThrow(EvidenceError);
    const flipped = envelope.ciphertext.startsWith('A')
      ? `B${envelope.ciphertext.slice(1)}`
      : `A${envelope.ciphertext.slice(1)}`;
    expect(() =>
      openEvidence(privateKey, Buffer.from(JSON.stringify({ ...envelope, ciphertext: flipped }))),
    ).toThrow(EvidenceError);
    expect(() => readEnvelope('{"format":"something else"}')).toThrow(EvidenceError);
  });

  it('takes RSA public keys of 3072 bits or more, as PEM or base64 DER', () => {
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(keyFingerprint(parseEvidencePublicKey(pem))).toBe(keyFingerprint(publicKey));
    expect(keyFingerprint(parseEvidencePublicKey(der))).toBe(keyFingerprint(publicKey));
    expect(keyFingerprint(privateKey)).toBe(keyFingerprint(publicKey));
    const small = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    expect(() =>
      parseEvidencePublicKey(small.export({ type: 'spki', format: 'pem' }).toString()),
    ).toThrow('3072 bits');
    const ed = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    expect(() => parseEvidencePublicKey(ed)).toThrow('RSA');
    expect(() => parseEvidencePublicKey('not a key')).toThrow(EvidenceError);
  });
});

describe('scanning settings', () => {
  const base = {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'https://credforge.test',
    DATABASE_URL: 'postgres://x@db/x',
  };
  const issues = (env: Record<string, string>) => {
    try {
      loadConfig({ ...base, ...env });
      return [];
    } catch (error) {
      if (error instanceof ConfigError) return error.issues;
      throw error;
    }
  };
  let evidenceKey: string;
  beforeAll(() => {
    evidenceKey = generateKeyPairSync('rsa', { modulusLength: 3072 })
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64');
  });

  it('scans nothing and matches nothing by default', () => {
    const { moderation } = loadConfig(base);
    expect(moderation.scan).toEqual({ images: false, text: false });
    expect(moderation.scanner).toEqual({ provider: 'none' });
    expect(moderation.csamMatcher).toEqual({ kind: 'none' });
    expect(moderation.thresholds).toEqual({ hold: 0.5, remove: null, categories: {} });
    expect(createScanners({ publicBaseUrl: base.PUBLIC_BASE_URL, moderation })).toEqual({});
  });

  it('needs the webhook’s URL, a long secret and who runs it', () => {
    expect(issues({ MODERATION_PROVIDER: 'webhook' })).toEqual([
      'MODERATION_WEBHOOK_URL: is required for MODERATION_PROVIDER=webhook',
      'MODERATION_WEBHOOK_SECRET: is required for MODERATION_PROVIDER=webhook',
      'MODERATION_WEBHOOK_NAME: is required for MODERATION_PROVIDER=webhook',
    ]);
    expect(issues({ MODERATION_WEBHOOK_SECRET: 'short' })[0]).toContain('at least 32 characters');
    expect(issues({ MODERATION_WEBHOOK_URL: 'ftp://scanner' })[0]).toContain('https://');
    const config = loadConfig({
      ...base,
      MODERATION_PROVIDER: 'webhook',
      MODERATION_WEBHOOK_URL: 'https://scanner.example.org/check',
      MODERATION_WEBHOOK_SECRET: SECRET,
      MODERATION_WEBHOOK_NAME: 'Example Moderation',
      MODERATION_SCAN: 'images',
    });
    expect(config.moderation.scan).toEqual({ images: true, text: false });
    const scanners = createScanners(config);
    expect(scanners.image?.name).toBe('Example Moderation');
    expect(scanners.text).toBeUndefined();
  });

  it('needs an OpenAI key for openai, and an evidence key for a matcher', () => {
    expect(issues({ MODERATION_PROVIDER: 'openai' })).toEqual([
      'MODERATION_OPENAI_API_KEY: is required for MODERATION_PROVIDER=openai',
    ]);
    const matcher = {
      CSAM_MATCHER: 'webhook',
      CSAM_MATCHER_URL: 'http://matcher:8080/match',
      CSAM_MATCHER_SECRET: SECRET,
      CSAM_MATCHER_NAME: 'Example matcher',
    };
    expect(issues(matcher)).toEqual([
      'CSAM_EVIDENCE_PUBLIC_KEY: is required for CSAM_MATCHER (matches are kept as sealed evidence)',
    ]);
    const config = loadConfig({ ...base, ...matcher, CSAM_EVIDENCE_PUBLIC_KEY: evidenceKey });
    // A matcher alone holds new images until it has checked them; text isn't scanned.
    expect(config.moderation.scan).toEqual({ images: true, text: false });
    expect(createScanners(config).csam?.name).toBe('Example matcher');
    expect(issues({ CSAM_EVIDENCE_PUBLIC_KEY: 'nope' })[0]).toContain('RSA public key');
  });

  it('checks thresholds, and wants https in production except on a private network', () => {
    expect(issues({ MODERATION_HOLD_THRESHOLD: '0' })[0]).toContain('above 0');
    expect(
      issues({ MODERATION_HOLD_THRESHOLD: '0.8', MODERATION_REMOVE_THRESHOLD: '0.7' }),
    ).toEqual(['MODERATION_REMOVE_THRESHOLD: must be at least MODERATION_HOLD_THRESHOLD']);
    expect(issues({ MODERATION_CATEGORY_THRESHOLDS: 'hate=2' })[0]).toContain('at most 1');
    expect(issues({ MODERATION_SCAN: 'audio' })[0]).toContain('images, text');
    const production = {
      NODE_ENV: 'production',
      AUTH_SECRET: 'a-long-random-production-auth-secret-value',
      CREDFORGE_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
      EMAIL_TRANSPORT: 'log',
      MODERATION_PROVIDER: 'webhook',
      MODERATION_WEBHOOK_SECRET: SECRET,
      MODERATION_WEBHOOK_NAME: 'Example',
    };
    expect(
      issues({ ...production, MODERATION_WEBHOOK_URL: 'http://scanner.example.org/x' })[0],
    ).toContain('must use https://');
    for (const url of [
      'http://moderation:8080/check',
      'http://10.0.0.5/check',
      'https://scanner.example.org',
    ]) {
      expect(issues({ ...production, MODERATION_WEBHOOK_URL: url }), url).toEqual([]);
    }
  });
});

describe('withholding images', () => {
  const image = { kind: 'image' as const, flags: [], scanStatus: null, scanResult: null };

  it('never shows a match, and not before the matcher has passed it', () => {
    expect(imageWithheld(image, true)).toBeNull();
    expect(
      imageWithheld(
        { ...image, flags: [{ source: 'hash_match', at: '', matcher: 'm', evidenceId: 'e' }] },
        false,
      ),
    ).toBe('known_csam');
    expect(imageWithheld({ ...image, scanStatus: 'waiting' }, true)).toBe('awaiting_check');
    expect(imageWithheld({ ...image, scanStatus: 'failed' }, true)).toBe('awaiting_check');
    expect(imageWithheld({ ...image, scanStatus: 'waiting' }, false)).toBeNull();
    expect(
      imageWithheld(
        {
          ...image,
          scanStatus: 'waiting',
          scanResult: { hashCheck: { matcher: 'm', matched: false, at: '' } },
        },
        true,
      ),
    ).toBeNull();
    expect(imageWithheld({ ...image, kind: 'text' }, true)).toBeNull();
  });
});
