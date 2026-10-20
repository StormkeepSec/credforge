import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signUpAndConfirm } from '../support/accounts';
import { expectScreen, openScreen } from '../support/app';
import { expectAccessible } from '../support/axe';
import { fixtures, SIGNED_IN, testEmail } from '../support/fixtures';
import { BASE_URL } from '../support/stack';
import { totp } from '../support/totp';

test.describe('as an organization owner', () => {
  test.use({ storageState: SIGNED_IN.owner });

  test('organization overview', async ({ page }) => {
    const { org } = fixtures();
    await openScreen(page, `/app/orgs/${org.id}`, org.name);
    await expect(page.getByRole('link', { name: 'Edit it' })).toBeVisible();
    await expectAccessible(page, 'org overview');
  });

  test('issuer profile', async ({ page }) => {
    const { org } = fixtures();
    await openScreen(page, `/app/orgs/${org.id}/issuer`, 'Issuer profile');
    await expect(page.getByLabel('Issuer name')).toHaveValue(org.name);
    await expectAccessible(page, 'issuer profile');
  });

  test('members, with an invitation error', async ({ page }) => {
    const { org, pendingInviteEmail } = fixtures();
    await openScreen(page, `/app/orgs/${org.id}/members`, 'Members');
    await expect(page.getByText(pendingInviteEmail)).toBeVisible();

    await page.getByLabel('Email address').fill('not-an-email');
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByLabel('Email address')).toHaveAttribute('aria-invalid', 'true');
    await expectAccessible(page, 'members with an invitation error');
  });

  test('organization settings and the audit log', async ({ page }) => {
    const { org } = fixtures();
    await openScreen(page, `/app/orgs/${org.id}/settings`, 'Organization settings');
    await expect(page.getByText('Org created')).toBeVisible();
    await expectAccessible(page, 'org settings');
  });

  test('account settings', async ({ page }) => {
    await openScreen(page, '/app/settings', 'Account settings');
    await expect(page.getByRole('button', { name: 'New backup codes' })).toBeVisible();
    await expectAccessible(page, 'account settings');
  });
});

test.describe('as someone with an invitation', () => {
  test.use({ storageState: SIGNED_IN.invitee });

  test('new organization, with the invitation to join', async ({ page }) => {
    const { org } = fixtures();
    await openScreen(page, '/app/orgs/new', 'Create an organization');
    await expect(page.getByText(org.name)).toBeVisible();
    await expectAccessible(page, 'new organization');
  });

  test('starts at My badges, with the invitation to join', async ({ page }) => {
    const { org } = fixtures();
    // Not a member of anything yet: /app leads to their own badges, not to creating an org.
    await page.goto('/app');
    await expectScreen(page, 'My badges');
    await expect(page.getByRole('heading', { name: 'You’re invited' })).toBeVisible();
    await expect(page.getByText(org.name)).toBeVisible();
    await expect(page.getByText('No badges yet')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create an organization' })).toBeVisible();
    await expectAccessible(page, 'my badges: none yet, with an invitation');
  });
});

test.describe('as a platform admin', () => {
  test.use({ storageState: SIGNED_IN.admin });

  test('the approval queue, and a reason to decline', async ({ page }) => {
    const { org } = fixtures();
    await openScreen(page, '/app/platform', 'Platform');
    const card = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: org.name }) });
    await expect(card).toBeVisible();
    await expectAccessible(page, 'platform');

    await card.getByRole('button', { name: 'Decline' }).click();
    await expect(card.getByRole('textbox', { name: /^Reason/ })).toBeFocused();
    await expectAccessible(page, 'platform: decline reason');
    await card.getByRole('button', { name: 'Cancel' }).click();
  });
});

test('a new account turns on two-step verification', async ({ page }) => {
  const { runId, password } = fixtures();
  const email = testEmail(runId, `twofa-${randomBytes(3).toString('hex')}`);
  await signUpAndConfirm(page.request, { name: 'E2E Two-Step', email, password });

  await openScreen(page, '/app/settings/two-factor', 'Turn on two-step verification');
  await expectAccessible(page, 'two-step setup: password');

  await page.getByLabel('Confirm your password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: '2. Scan this code with the app' })).toBeFocused();
  await expectAccessible(page, 'two-step setup: QR code');

  const key = page
    .getByText('Enter this key in the app instead:')
    .locator('xpath=following-sibling::p[1]');
  // The entry is named after this site, so it can't be mistaken for another credforge's.
  await expect(
    page.getByText(`Name the entry credforge (${new URL(BASE_URL).hostname})`),
  ).toBeVisible();
  await page.getByLabel('Code from the app').fill(totp((await key.textContent()) ?? ''));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('heading', { name: '3. Save your backup codes' })).toBeFocused();
  await expectAccessible(page, 'two-step setup: backup codes');
});
