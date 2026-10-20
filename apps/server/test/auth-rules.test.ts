import { describe, expect, it } from 'vitest';
import { totpIssuer, totpUriWithIssuer } from '../src/auth/auth';
import { isAuthPathAllowed, mfaState } from '../src/auth/mfa';
import { isMicrosoftEmailVerified, stripProviderTokens } from '../src/auth/providers';
import { describeTwoFactorReset } from '../src/auth/two-factor-reset';

describe('mfaState', () => {
  it('challenges every session of a user with two-step verification until it passes', () => {
    expect(mfaState({ required: false, twoFactorEnabled: true, sessionVerified: false })).toBe(
      'challenge',
    );
    expect(mfaState({ required: true, twoFactorEnabled: true, sessionVerified: false })).toBe(
      'challenge',
    );
    expect(mfaState({ required: true, twoFactorEnabled: true, sessionVerified: true })).toBe('ok');
  });

  it('sends privileged users without it to set it up', () => {
    expect(mfaState({ required: true, twoFactorEnabled: false, sessionVerified: false })).toBe(
      'setup',
    );
  });

  it('leaves everyone else alone', () => {
    expect(mfaState({ required: false, twoFactorEnabled: false, sessionVerified: false })).toBe(
      'ok',
    );
  });
});

describe('isAuthPathAllowed', () => {
  it('allows everything once the session is ok', () => {
    expect(isAuthPathAllowed('/two-factor/disable', 'ok')).toBe(true);
    expect(isAuthPathAllowed('/link-social', 'ok')).toBe(true);
  });

  it('allows only the way through while a challenge is pending', () => {
    for (const path of [
      '/get-session',
      '/sign-out',
      '/two-factor/verify-totp',
      '/two-factor/verify-backup-code',
      '/callback/google',
      '/reset-password/abc',
    ]) {
      expect(isAuthPathAllowed(path, 'challenge'), path).toBe(true);
    }
    for (const path of [
      '/two-factor/disable',
      '/two-factor/get-totp-uri',
      '/two-factor/enable',
      '/link-social',
      '/unlink-account',
      '/list-accounts',
      '/change-password',
      '/update-user',
      '/revoke-sessions',
    ]) {
      expect(isAuthPathAllowed(path, 'challenge'), path).toBe(false);
    }
  });

  it('also allows enabling two-step verification during setup', () => {
    expect(isAuthPathAllowed('/two-factor/enable', 'setup')).toBe(true);
    expect(isAuthPathAllowed('/two-factor/get-totp-uri', 'setup')).toBe(true);
    expect(isAuthPathAllowed('/two-factor/disable', 'setup')).toBe(false);
    expect(isAuthPathAllowed('/link-social', 'setup')).toBe(false);
  });
});

describe('isMicrosoftEmailVerified', () => {
  it('trusts only a true xms_edov claim', () => {
    expect(isMicrosoftEmailVerified({ xms_edov: true })).toBe(true);
    expect(isMicrosoftEmailVerified({ xms_edov: 'true' })).toBe(true);
    expect(isMicrosoftEmailVerified({ xms_edov: 1 })).toBe(true);
    expect(isMicrosoftEmailVerified({ xms_edov: false })).toBe(false);
    expect(isMicrosoftEmailVerified({ xms_edov: '0' })).toBe(false);
    expect(isMicrosoftEmailVerified({ email_verified: true })).toBe(false);
    expect(isMicrosoftEmailVerified({})).toBe(false);
  });
});

describe('stripProviderTokens', () => {
  it('removes every token, keeping the rest', () => {
    expect(
      stripProviderTokens({
        providerId: 'google',
        accountId: '123',
        accessToken: 'a',
        refreshToken: 'r',
        idToken: 'i',
        accessTokenExpiresAt: new Date(),
        refreshTokenExpiresAt: new Date(),
        scope: 'openid email profile',
      }),
    ).toEqual({
      providerId: 'google',
      accountId: '123',
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: 'openid email profile',
    });
  });

  it('leaves updates without tokens alone', () => {
    expect(stripProviderTokens({ password: 'hash' })).toEqual({ password: 'hash' });
  });
});

describe('totpIssuer', () => {
  it("names the authenticator entry after the instance's host", () => {
    expect(totpIssuer('https://credforge.app')).toBe('credforge (credforge.app)');
    expect(totpIssuer('http://localhost:5173')).toBe('credforge (localhost)');
    expect(totpIssuer('https://badges.example.org/')).toBe('credforge (badges.example.org)');
    expect(totpIssuer('http://127.0.0.1:3000')).toBe('credforge (127.0.0.1)');
  });

  it('falls back to plain credforge for an IPv6 address (the label separator is a colon)', () => {
    expect(totpIssuer('http://[::1]:3000')).toBe('credforge');
  });
});

describe('totpUriWithIssuer', () => {
  const expected =
    'otpauth://totp/credforge%20(credforge.app):jordan%2Bbadges%40acme.edu?secret=JBSWY3DPEHPK3PXP&issuer=credforge%20(credforge.app)&digits=6&period=30';

  it('percent-encodes the issuer parameter (Better Auth writes a space as +)', () => {
    const fromEnable =
      'otpauth://totp/credforge%20(credforge.app):jordan%2Bbadges%40acme.edu?secret=JBSWY3DPEHPK3PXP&issuer=credforge+%28credforge.app%29&digits=6&period=30';
    const uri = totpUriWithIssuer(fromEnable, 'credforge (credforge.app)');
    expect(uri).toBe(expected);
    expect(uri).not.toContain('+');
    const parsed = new URL(uri);
    expect(parsed.searchParams.get('issuer')).toBe('credforge (credforge.app)');
    expect(parsed.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(decodeURIComponent(parsed.pathname)).toBe(
      '/credforge (credforge.app):jordan+badges@acme.edu',
    );
  });

  it('replaces another issuer in the label and the parameter (get-totp-uri, a client’s own)', () => {
    const fromGetTotpUri =
      'otpauth://totp/credforge:jordan%2Bbadges%40acme.edu?secret=JBSWY3DPEHPK3PXP&issuer=credforge&digits=6&period=30';
    expect(totpUriWithIssuer(fromGetTotpUri, 'credforge (credforge.app)')).toBe(expected);
  });
});

describe('describeTwoFactorReset', () => {
  const reset = {
    outcome: 'reset',
    userId: '00000000-0000-4000-8000-000000000000',
    sessionsEnded: 1,
    wasLocked: false,
    setupRequired: true,
  } as const;

  it('says what was removed and that an admin must set it up again', () => {
    const text = describeTwoFactorReset('admin@example.org', reset);
    expect(text).toContain('Two-step verification is off for admin@example.org');
    expect(text).toContain('1 session ended');
    expect(text).not.toContain('lockout');
    expect(text).toContain('REQUIRE_MFA_FOR_ADMINS=true');
    expect(text).toContain('at their next sign-in they must set it up again');
  });

  it('mentions a cleared lockout, and that others may turn it on again', () => {
    const text = describeTwoFactorReset('someone@example.org', {
      ...reset,
      sessionsEnded: 3,
      wasLocked: true,
      setupRequired: false,
    });
    expect(text).toContain('the lockout after wrong codes is cleared');
    expect(text).toContain('3 sessions ended');
    expect(text).toContain('can turn two-step verification on again in Account settings');
    expect(text).not.toContain('REQUIRE_MFA_FOR_ADMINS');
  });

  it('refuses unknown addresses and says when it was off', () => {
    expect(describeTwoFactorReset('nobody@example.org', { outcome: 'no_account' })).toContain(
      'No account uses nobody@example.org',
    );
    expect(describeTwoFactorReset('a@example.org', { outcome: 'not_on' })).toBe(
      "Two-step verification isn't on for a@example.org. Nothing changed.",
    );
  });
});
