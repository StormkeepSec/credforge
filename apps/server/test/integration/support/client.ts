import { createHmac, randomBytes } from 'node:crypto';
import { eq, user } from '@credforge/db';
import type { LightMyRequestResponse } from 'fastify';
import { BASE_URL, type TestEnvironment } from './harness';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** A browser-like client: keeps cookies and sends this site's Origin, like the issuer app. */
export class TestClient {
  readonly cookies = new Map<string, string>();
  /** The TOTP secret, once two-step verification is on. */
  totpSecret?: Buffer;

  constructor(
    readonly env: TestEnvironment,
    readonly email: string,
    readonly password: string,
  ) {}

  async request(method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await this.env.app.inject({
      method,
      url,
      headers: {
        origin: BASE_URL,
        ...(this.cookies.size > 0 && { cookie: this.cookieHeader() }),
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body !== undefined && { payload: JSON.stringify(body) }),
    });
    this.storeCookies(response);
    return response;
  }

  get(url: string, headers?: Record<string, string>) {
    return this.request('GET', url, undefined, headers);
  }
  post(url: string, body: unknown = {}) {
    return this.request('POST', url, body);
  }
  patch(url: string, body: unknown) {
    return this.request('PATCH', url, body);
  }
  delete(url: string) {
    return this.request('DELETE', url);
  }

  /** Sends a file as the raw request body, as the issuer app uploads images. */
  async upload(url: string, body: Buffer, contentType: string, method: 'PUT' | 'POST' = 'PUT') {
    const response = await this.env.app.inject({
      method,
      url,
      headers: {
        origin: BASE_URL,
        'content-type': contentType,
        ...(this.cookies.size > 0 && { cookie: this.cookieHeader() }),
      },
      payload: body,
    });
    this.storeCookies(response);
    return response;
  }

  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private storeCookies(response: LightMyRequestResponse) {
    for (const cookie of response.cookies as {
      name: string;
      value: string;
      maxAge?: number;
      expires?: Date;
    }[]) {
      const expired =
        cookie.value === '' ||
        cookie.maxAge === 0 ||
        (cookie.expires !== undefined && cookie.expires.getTime() < Date.now());
      if (expired) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
  }

  async signIn() {
    const response = await this.post('/api/auth/sign-in/email', {
      email: this.email,
      password: this.password,
    });
    if (response.statusCode !== 200) throw new Error(`sign-in failed: ${response.body}`);
    const body = response.json() as { twoFactorRedirect?: boolean };
    if (body.twoFactorRedirect) await this.verifyTotp();
    return this;
  }

  /** Turns on TOTP two-step verification. The session that confirms it counts as verified. */
  async enableTwoFactor() {
    const enabled = await this.post('/api/auth/two-factor/enable', { password: this.password });
    if (enabled.statusCode !== 200) throw new Error(`2FA enable failed: ${enabled.body}`);
    const { totpURI } = enabled.json() as { totpURI: string };
    this.totpSecret = base32Decode(new URL(totpURI).searchParams.get('secret') ?? '');
    await this.verifyTotp();
    return this;
  }

  async verifyTotp() {
    if (!this.totpSecret) throw new Error('No TOTP secret.');
    const response = await this.post('/api/auth/two-factor/verify-totp', {
      code: totp(this.totpSecret),
    });
    if (response.statusCode !== 200) throw new Error(`TOTP verify failed: ${response.body}`);
    return response;
  }

  async me() {
    return (await this.get('/api/v1/me')).json();
  }
}

export interface NewUserOptions {
  email?: string;
  name?: string;
  password?: string;
  /** Turn on two-step verification after signing up (default true). */
  twoFactor?: boolean;
  platformAdmin?: boolean;
}

/**
 * Signs up with email and password, follows the verification link from the captured email
 * (which signs the user in), and optionally turns on two-step verification.
 */
export async function newUser(env: TestEnvironment, options: NewUserOptions = {}) {
  const email = options.email ?? `user-${randomBytes(4).toString('hex')}@example.org`;
  const password = options.password ?? 'correct horse battery staple';
  const client = new TestClient(env, email, password);

  const signUp = await client.post('/api/auth/sign-up/email', {
    name: options.name ?? email.split('@')[0],
    email,
    password,
  });
  if (signUp.statusCode !== 200) throw new Error(`sign-up failed: ${signUp.body}`);
  const link = verificationLink(env, email);
  const verified = await client.get(new URL(link).pathname + new URL(link).search);
  if (verified.statusCode !== 302)
    throw new Error(`verify failed: ${verified.statusCode} ${verified.body}`);

  if (options.platformAdmin) {
    await env.ownerDb.update(user).set({ isPlatformAdmin: true }).where(eq(user.email, email));
  }
  if (options.twoFactor ?? true) await client.enableTwoFactor();
  return client;
}

export function lastEmailTo(env: TestEnvironment, to: string, kind?: string) {
  const message = [...env.outbox.messages]
    .reverse()
    .find((sent) => sent.to === to && (!kind || sent.kind === kind));
  if (!message) throw new Error(`No ${kind ?? ''} email to ${to}`);
  return message;
}

export function verificationLink(env: TestEnvironment, to: string): string {
  const match = lastEmailTo(env, to, 'verify-email').text.match(/https:\/\/\S+verify-email\?\S+/);
  if (!match) throw new Error('No verification link in email.');
  return match[0];
}

export function linkIn(text: string, pattern: RegExp): string {
  const match = text.match(pattern);
  if (!match) throw new Error(`No link matching ${pattern} in:\n${text}`);
  return match[0];
}

export function expectProblem(response: LightMyRequestResponse, status: number, code: string) {
  if (response.statusCode !== status || (response.json() as { code?: string }).code !== code) {
    throw new Error(`Expected ${status} ${code}, got ${response.statusCode} ${response.body}`);
  }
}

// ---- TOTP (RFC 6238), independent of Better Auth's implementation ----

export function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error(`Bad base32 character ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secret: Buffer, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac('sha1', secret).update(counter).digest();
  const offset = (hmac.at(-1) ?? 0) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}
