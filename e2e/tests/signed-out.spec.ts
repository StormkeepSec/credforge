import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { post, signIn, signUpAndConfirm } from '../support/accounts';
import { expectScreen, openScreen } from '../support/app';
import { expectAccessible } from '../support/axe';
import { fixtures, testEmail } from '../support/fixtures';
import { LINKS, mailLink } from '../support/mailpit';
import { totp } from '../support/totp';

const freshEmail = (who: string) =>
  testEmail(fixtures().runId, `${who}-${randomBytes(3).toString('hex')}`);

test('sign up: the form, its validation errors, and confirming the email', async ({ page }) => {
  await openScreen(page, '/signup', 'Create your account');
  await expectAccessible(page, 'sign-up');

  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByLabel('Your name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Use at least 10 characters')).toBeVisible();
  await expectAccessible(page, 'sign-up with validation errors');

  const email = freshEmail('signup');
  await page.getByLabel('Your name').fill('E2E Sign-up');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(fixtures().password);
  await page.getByRole('button', { name: 'Create account' }).click();
  // The form is replaced by the next step: focus goes to its heading, not back to <body>.
  await expect(page.getByRole('heading', { level: 1, name: 'Check your inbox' })).toBeFocused();
  await expectAccessible(page, 'sign-up: check your inbox');

  await page.goto(await mailLink(email, LINKS.verifyEmail));
  await expectScreen(page, 'Email confirmed');
  await expectAccessible(page, 'email confirmed');
});

test('verify email: a link that didn’t work', async ({ page }) => {
  await openScreen(page, '/verify-email?error=invalid_token', 'That link didn’t work');
  await expectAccessible(page, 'verify-email error');
});

test('sign in, and a failed sign-in', async ({ page }) => {
  await openScreen(page, '/login', 'Sign in');
  await expectAccessible(page, 'sign-in');

  await page.getByLabel('Email').fill(freshEmail('nobody'));
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expectAccessible(page, 'sign-in failed');
});

test('forgot password: the form and the confirmation', async ({ page }) => {
  await openScreen(page, '/forgot-password', 'Set a new password');
  await expectAccessible(page, 'forgot-password');

  await page.getByLabel('Email').fill(freshEmail('forgot'));
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Check your inbox' })).toBeVisible();
  await expectAccessible(page, 'forgot-password sent');
});

test('reset password without a token', async ({ page }) => {
  await openScreen(page, '/reset-password', 'Choose a new password');
  await expect(page.getByRole('link', { name: 'Get a new link' })).toBeVisible();
  await expectAccessible(page, 'reset-password without a token');
});

test('reset password with a token from the email, and a too-short password', async ({ page }) => {
  // An account of its own: the reset link must not touch the seeded accounts.
  const account = { name: 'E2E Reset', email: freshEmail('reset'), password: fixtures().password };
  await signUpAndConfirm(page.request, account);
  await post(page.request, '/api/auth/sign-out');
  await post(page.request, '/api/auth/request-password-reset', {
    email: account.email,
    redirectTo: '/reset-password',
  });

  await page.goto(await mailLink(account.email, LINKS.resetPassword));
  await expectScreen(page, 'Choose a new password');
  await expectAccessible(page, 'reset-password');

  await page.getByLabel('New password').fill('short');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('alert')).toHaveText('Use at least 10 characters.');
  await expectAccessible(page, 'reset-password too short');
});

test('two-step verification after a password sign-in', async ({ page }) => {
  const { owner, password, org } = fixtures();
  expect((await signIn(page.request, { email: owner.email, password })).twoFactorRedirect).toBe(
    true,
  );
  await openScreen(page, '/two-factor', 'Two-step verification');
  await expectAccessible(page, 'two-factor challenge');

  await page.getByLabel('Code').fill(totp(owner.totpSecret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expectScreen(page, org.name);
});

test('an invitation link', async ({ page }) => {
  const { inviteToken, org } = fixtures();
  await openScreen(page, `/invite/${inviteToken}`, `Join ${org.name}`);
  await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible();
  await expectAccessible(page, 'invitation');
});

test('an invitation link that can’t be used', async ({ page }) => {
  await openScreen(page, '/invite/not-a-real-token', 'This invitation can’t be used');
  await expectAccessible(page, 'invalid invitation');
});
