import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/api/rate-limit';
import { createSafeFetcher, FetchError, isPublicAddress } from '../src/verify/fetch';

describe('rate limiter', () => {
  it('allows `max` requests per window and per key', () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000 });
    expect(limiter.take('a', 0).allowed).toBe(true);
    expect(limiter.take('a', 1).allowed).toBe(true);
    expect(limiter.take('a', 2)).toEqual({ allowed: false, retryAfter: 60 });
    expect(limiter.take('b', 2).allowed).toBe(true);
    expect(limiter.take('a', 60_001).allowed).toBe(true);
  });

  it('does nothing with a limit of 0', () => {
    const limiter = createRateLimiter({ max: 0, windowMs: 60_000 });
    for (let i = 0; i < 100; i++) expect(limiter.take('a').allowed).toBe(true);
  });
});

describe('fetching documents for verification', () => {
  it('knows which addresses are public', () => {
    for (const address of ['93.184.215.14', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '64:ff9b::7f00:1',
      'not-an-ip',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('refuses anything but public HTTPS on the standard port', async () => {
    const fetcher = createSafeFetcher({
      resolve: async (host) =>
        host === 'internal.example'
          ? [{ address: '10.0.0.5', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }],
    });
    const refused = async (url: string) => {
      const error = await fetcher(url, 'application/json').catch((caught) => caught);
      expect(error, url).toBeInstanceOf(FetchError);
      return (error as Error).message;
    };
    expect(await refused('http://example.org/x')).toMatch(/https/);
    expect(await refused('https://example.org:8443/x')).toMatch(/standard HTTPS port/);
    expect(await refused('https://user:pw@example.org/x')).toMatch(/password/);
    expect(await refused('https://internal.example/x')).toMatch(/isn’t a public address/);
    expect(await refused('https://127.0.0.1/x')).toMatch(/isn’t a public address/);
    expect(await refused('https://[::1]/x')).toMatch(/isn’t a public address/);
    expect(await refused('not a url')).toMatch(/web address/);
  });

  it('refuses a host if any of its addresses is private', async () => {
    const fetcher = createSafeFetcher({
      resolve: async () => [
        { address: '93.184.215.14', family: 4 },
        { address: '192.168.0.10', family: 4 },
      ],
    });
    await expect(fetcher('https://mixed.example/x', 'application/json')).rejects.toThrow(
      /isn’t a public address/,
    );
  });
});
