import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/** A document fetched from another site for verification. */
export interface FetchedDocument {
  url: string;
  contentType: string;
  body: Buffer;
}

/** Something that fetches public documents (issuer profiles, status lists, credentials). */
export type DocumentFetcher = (url: string, accept: string) => Promise<FetchedDocument>;

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchError';
  }
}

/**
 * Addresses a verifier must never connect to: loopback, private networks, link-local (cloud
 * metadata services live at 169.254.169.254), carrier-grade NAT, documentation and reserved
 * ranges, multicast, and the IPv6 equivalents. Without this the /verify tool could be pointed at
 * the server's own network (SSRF).
 */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/** Whether an IP address is one a verifier may connect to. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // BlockList checks IPv4-mapped IPv6 (::ffff:10.0.0.1) against the IPv4 rules.
  return !BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  /** Resolves a host name; the default is the system resolver. Tests pass their own. */
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

/**
 * Fetches a public HTTPS document for verification, refusing anything that could reach a private
 * network: HTTPS on the default port only, every address the host resolves to must be public, the
 * connection is pinned to the checked address (no second DNS lookup to rebind), each redirect is
 * checked the same way, and size and time are capped.
 */
export function createSafeFetcher(options: SafeFetchOptions = {}): DocumentFetcher {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBytes = options.maxBytes ?? 3 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const resolve =
    options.resolve ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));

  async function checkedAddress(url: URL): Promise<{ address: string; family: number }> {
    if (url.protocol !== 'https:') throw new FetchError('Only https:// addresses can be checked.');
    if (url.port && url.port !== '443') {
      throw new FetchError('Only addresses on the standard HTTPS port can be checked.');
    }
    if (url.username || url.password)
      throw new FetchError('Addresses with a password aren’t allowed.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await resolve(host).catch(() => []);
    if (addresses.length === 0) throw new FetchError(`Couldn’t find ${url.hostname}.`);
    if (!addresses.every((entry) => isPublicAddress(entry.address))) {
      throw new FetchError(`${url.hostname} isn’t a public address.`);
    }
    return addresses[0] as { address: string; family: number };
  }

  function once(url: URL, accept: string, pinned: { address: string; family: number }) {
    const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    };
    return new Promise<{ status: number; location?: string; contentType: string; body: Buffer }>(
      (resolvePromise, reject) => {
        const req = httpsRequest(
          url,
          {
            method: 'GET',
            lookup,
            headers: {
              accept,
              'user-agent': options.userAgent ?? 'credforge-verifier',
              'accept-encoding': 'identity',
            },
            timeout: timeoutMs,
          },
          (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              res.resume();
              resolvePromise({
                status,
                location: res.headers.location,
                contentType: '',
                body: Buffer.alloc(0),
              });
              return;
            }
            const declared = Number(res.headers['content-length'] ?? 0);
            if (declared > maxBytes) {
              res.destroy();
              reject(new FetchError('The document is too large.'));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > maxBytes) {
                res.destroy();
                reject(new FetchError('The document is too large.'));
                return;
              }
              chunks.push(chunk);
            });
            res.on('end', () =>
              resolvePromise({
                status,
                contentType: String(res.headers['content-type'] ?? ''),
                body: Buffer.concat(chunks),
              }),
            );
            res.on('error', reject);
          },
        );
        req.on('timeout', () => req.destroy(new FetchError('The site took too long to answer.')));
        req.on('error', (error) =>
          reject(
            error instanceof FetchError
              ? error
              : new FetchError(`Couldn’t connect: ${error.message}`),
          ),
        );
        req.end();
      },
    );
  }

  return async (address, accept) => {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw new FetchError('That isn’t a web address.');
    }
    const deadline = Date.now() + timeoutMs;
    for (let redirects = 0; ; redirects++) {
      if (Date.now() > deadline) throw new FetchError('The site took too long to answer.');
      const pinned = await checkedAddress(url);
      const response = await once(url, accept, pinned);
      if (response.status >= 300 && response.status < 400) {
        if (!response.location || redirects >= maxRedirects) {
          throw new FetchError('Too many redirects.');
        }
        url = new URL(response.location, url);
        continue;
      }
      if (response.status !== 200) {
        throw new FetchError(`The site answered ${response.status}.`);
      }
      return { url: url.toString(), contentType: response.contentType, body: response.body };
    }
  };
}
