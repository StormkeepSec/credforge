import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/api/openapi';
import { apiKeyScopeFor, OPERATIONS, openApiPath } from '../src/api/operations';
import {
  apiKeyMatches,
  apiKeyPrefix,
  bearerToken,
  generateApiKey,
  hashApiKey,
} from '../src/api-keys/keys';
import { verifiableHost, verificationValue } from '../src/issuers/domain';
import { redactUrl } from '../src/logger';

describe('API keys', () => {
  it('are cf_, a 12-character prefix and 256 random bits', () => {
    const keys = Array.from({ length: 50 }, generateApiKey);
    for (const { key, prefix, hash } of keys) {
      expect(key).toMatch(/^cf_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
      expect(apiKeyPrefix(key)).toBe(prefix);
      expect(hash).toBe(hashApiKey(key));
      expect(apiKeyMatches(key, hash)).toBe(true);
      expect(apiKeyMatches(`${key.slice(0, -1)}A`, hash)).toBe(key.endsWith('A'));
    }
    expect(new Set(keys.map((key) => key.prefix)).size).toBe(50);
  });

  it('look nothing up for malformed keys', () => {
    expect(apiKeyPrefix('cf_short_abc')).toBeNull();
    expect(apiKeyPrefix('Bearer cf_x')).toBeNull();
    expect(apiKeyMatches('x', 'not-hex')).toBe(false);
  });

  it('read the bearer token from the Authorization header', () => {
    expect(bearerToken('Bearer cf_abc')).toBe('cf_abc');
    expect(bearerToken('bearer   cf_abc  ')).toBe('cf_abc');
    expect(bearerToken('Basic dXNlcg==')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('log redaction', () => {
  it('takes secrets and addresses out of request URLs', () => {
    expect(redactUrl('/credentials/abc?t=SECRET')).toBe('/credentials/abc?t=[redacted]');
    expect(redactUrl('/reset-password?token=SECRET&x=1')).toBe(
      '/reset-password?token=[redacted]&x=1',
    );
    expect(redactUrl('/api/auth/callback/google?code=C&state=S')).toBe(
      '/api/auth/callback/google?code=[redacted]&state=[redacted]',
    );
    expect(redactUrl('/invite/SECRET')).toBe('/invite/[redacted]');
    expect(redactUrl('/api/v1/invitations/SECRET/accept')).toBe(
      '/api/v1/invitations/[redacted]/accept',
    );
    expect(redactUrl('/verify?url=https%3A%2F%2Fexample.org')).toBe('/verify?url=[redacted]');
    expect(redactUrl('/login?email=a%40b.org')).toBe('/login?email=[redacted]');
    expect(redactUrl('/api/v1/me/invitations/0b6f3c1e/accept')).toBe(
      '/api/v1/me/invitations/0b6f3c1e/accept',
    );
    expect(redactUrl('/x?%E0%A4%A=1')).toBe('/x?%E0%A4%A=1');
  });
});

describe('operations and the OpenAPI document', () => {
  it('maps Fastify routes to documented paths', () => {
    expect(openApiPath('/api/v1/orgs/:orgId/credentials/:credentialId')).toBe(
      '/orgs/{orgId}/credentials/{credentialId}',
    );
    expect(openApiPath('/api/v1/orgs/:orgId/')).toBe('/orgs/{orgId}');
  });

  it('lets API keys use only the operations marked for them', () => {
    expect(apiKeyScopeFor('POST', '/api/v1/orgs/:orgId/credentials')).toBe('credential:issue');
    expect(apiKeyScopeFor('GET', '/api/v1/orgs/:orgId/members')).toBeNull();
    expect(apiKeyScopeFor('POST', '/api/v1/orgs/:orgId/api-keys')).toBeNull();
    expect(apiKeyScopeFor('GET', '/api/v1/orgs/:orgId/')).toBeNull();
    expect(apiKeyScopeFor('GET', '/api/v1/nothing')).toBeNull();
    for (const op of OPERATIONS) {
      if (op.auth.kind === 'org' && op.auth.apiKey) {
        expect(op.auth.permission, `${op.method} ${op.path}`).not.toMatch(/^(member|org|api_key):/);
      }
    }
  });

  it('builds an OpenAPI 3.1 document with unique operation ids', () => {
    const document = buildOpenApiDocument('https://credforge.test') as {
      paths: Record<string, Record<string, { operationId: string; responses: object }>>;
    };
    const ids = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods).map((op) => op.operationId),
    );
    expect(ids.length).toBe(OPERATIONS.length);
    expect(new Set(ids).size).toBe(ids.length);
    const award = document.paths['/orgs/{orgId}/credentials']?.post;
    expect(award?.responses).toHaveProperty('201');
    expect(award?.responses).toHaveProperty('429');
  });
});

describe('domain verification', () => {
  it('verifies host names only', () => {
    expect(verifiableHost('https://Example.org/about')).toBe('example.org');
    expect(verifiableHost('https://www.example.org')).toBe('www.example.org');
    expect(verifiableHost('https://203.0.113.7')).toBeNull();
    expect(verifiableHost('http://localhost:3000')).toBeNull();
    expect(verifiableHost(null)).toBeNull();
    expect(verificationValue('abc')).toBe('credforge-verify=abc');
  });
});
