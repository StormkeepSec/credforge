import { describe, expect, it } from 'vitest';
import { isAuthPathAllowed, mfaState } from '../src/auth/mfa';
import { isMicrosoftEmailVerified, stripProviderTokens } from '../src/auth/providers';

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
