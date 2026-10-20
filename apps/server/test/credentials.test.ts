import { describe, expect, it } from 'vitest';
import {
  CLAIM_TOKEN_DAYS,
  hashClaimToken,
  isValidClaimToken,
  newClaimToken,
  resolveValidFrom,
  resolveValidUntil,
} from '../src/credentials/service';
import { linkedInUrl } from '../src/public/credential-view';
import type { CredentialView } from '../src/public/pages/credential';

const now = new Date('2026-10-14T12:00:00Z');

describe('claim tokens', () => {
  it('are 256-bit, stored only as a hash, and last 90 days', () => {
    const claim = newClaimToken(now);
    expect(Buffer.from(claim.token, 'base64url')).toHaveLength(32);
    expect(claim.hash).toBe(hashClaimToken(claim.token));
    expect(claim.hash).not.toContain(claim.token);
    expect(claim.expiresAt.getTime() - now.getTime()).toBe(CLAIM_TOKEN_DAYS * 86_400_000);
    expect(newClaimToken(now).token).not.toBe(claim.token);
  });

  it('work only while current and unexpired', () => {
    const claim = newClaimToken(now);
    const row = { claimTokenHash: claim.hash, claimTokenExpiresAt: claim.expiresAt };
    expect(isValidClaimToken(row, claim.token, now)).toBe(true);
    expect(isValidClaimToken(row, `${claim.token}x`, now)).toBe(false);
    expect(isValidClaimToken(row, undefined, now)).toBe(false);
    expect(isValidClaimToken(row, claim.token, claim.expiresAt)).toBe(false);
    expect(
      isValidClaimToken({ claimTokenHash: null, claimTokenExpiresAt: null }, claim.token),
    ).toBe(false);
  });
});

describe('award dates', () => {
  it('defaults to now and reads a calendar date as that day', () => {
    expect(resolveValidFrom(undefined, now)).toBe(now);
    expect(resolveValidFrom('2026-01-15', now).toISOString()).toBe('2026-01-15T00:00:00.000Z');
    // "Today" in a time zone ahead of UTC is tomorrow in UTC: it becomes now.
    expect(resolveValidFrom('2026-10-15', now)).toBe(now);
    expect(() => resolveValidFrom('2026-10-17', now)).toThrow();
  });

  it('expires at the end of the given day, after the achievement’s validity, or never', () => {
    const from = new Date('2026-01-15T00:00:00Z');
    expect(resolveValidUntil('2027-01-15', from, null)?.toISOString()).toBe(
      '2027-01-15T23:59:59.000Z',
    );
    expect(resolveValidUntil(undefined, from, 30)?.toISOString()).toBe('2026-02-14T00:00:00.000Z');
    expect(resolveValidUntil(undefined, from, null)).toBeUndefined();
    expect(resolveValidUntil(null, from, 30)).toBeUndefined();
    expect(() => resolveValidUntil('2026-01-14', from, null)).toThrow();
  });
});

describe('Add to LinkedIn', () => {
  it('fills in LinkedIn’s certification form', () => {
    const view = {
      achievement: { name: 'Intro to Network Defense' },
      issuer: { name: 'Example Cyber Academy' },
      validFrom: new Date('2026-11-02T15:04:05Z'),
      validUntil: new Date('2028-03-01T00:00:00Z'),
    } as CredentialView;
    const url = new URL(linkedInUrl(view, 'https://credforge.app/credentials/abc', 'abc'));
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/profile/add');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      startTask: 'CERTIFICATION_NAME',
      name: 'Intro to Network Defense',
      organizationName: 'Example Cyber Academy',
      issueYear: '2026',
      issueMonth: '11',
      expirationYear: '2028',
      expirationMonth: '3',
      certUrl: 'https://credforge.app/credentials/abc',
      certId: 'abc',
    });
  });
});
