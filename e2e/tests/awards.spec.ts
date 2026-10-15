import { extractFromPng, verifyCredential } from '@credforge/ob3';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { BADGE_SVG } from '../support/accounts';
import { expectScreen, openScreen } from '../support/app';
import { expectAccessible } from '../support/axe';
import { fixtures, SIGNED_IN, testEmail } from '../support/fixtures';
import { mailLink } from '../support/mailpit';
import { BASE_URL } from '../support/stack';

// M3: achievements, awarding, the recipient's claim link and public pages, delivery status.

/** Fetches a URL the way an outside verifier would: JSON, no cookies. */
function verifierFetch(request: APIRequestContext) {
  return async (url: string) => {
    const response = await request.get(url.replace(/^https?:\/\/[^/]+/, BASE_URL), {
      headers: { accept: 'application/json' },
    });
    return response.ok() ? response.json() : undefined;
  };
}

test.describe('as an organization owner', () => {
  test.use({ storageState: SIGNED_IN.owner });

  test('achievements', async ({ page }) => {
    const { org, achievement } = fixtures();
    await openScreen(page, `/app/orgs/${org.id}/achievements`, 'Achievements');
    await expect(page.getByRole('link', { name: new RegExp(achievement.name) })).toBeVisible();
    await expectAccessible(page, 'achievements');
  });

  test('create an achievement: validation, image, preview and the draft', async ({ page }) => {
    const { org, runId } = fixtures();
    await openScreen(page, `/app/orgs/${org.id}/achievements/new`, 'New achievement');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expectAccessible(page, 'new achievement with validation errors');

    const name = `E2E Draft ${runId}`;
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Description').fill('A draft made by the end-to-end tests.');
    await page.getByLabel('How it is earned').fill('Run the tests.');
    await page.getByLabel('Badge image').setInputFiles({
      name: 'badge.svg',
      mimeType: 'image/svg+xml',
      buffer: BADGE_SVG,
    });
    // The live preview follows the form.
    await expect(page.getByRole('figure').filter({ hasText: name })).toBeVisible();
    await page.getByRole('button', { name: 'Add alignment' }).click();
    await expect(page.getByRole('group', { name: 'Alignment 1' }).getByLabel('Name')).toBeFocused();
    await page.getByRole('button', { name: 'Remove alignment 1' }).click();
    await page.getByRole('button', { name: 'Save draft' }).click();

    await expectScreen(page, name);
    await expect(page.getByText('Draft saved.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish' })).toBeEnabled();
    await expectAccessible(page, 'achievement draft');
  });

  test('award a badge to yourself; the recipient’s page, downloads and certificate', async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    const { org, achievement } = fixtures();
    await openScreen(
      page,
      `/app/orgs/${org.id}/award?achievementId=${achievement.id}`,
      'Award a badge',
    );
    await expectAccessible(page, 'award a badge');

    await page.getByRole('button', { name: 'Award badge' }).click();
    await expect(page.getByLabel('Recipient’s email address')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await page.getByRole('button', { name: 'Award it to myself' }).click();
    await page.getByRole('button', { name: 'Award badge' }).click();
    await expect(page.getByRole('heading', { name: 'Awarded to E2E Owner' })).toBeFocused();
    await expectAccessible(page, 'awarded');

    // The recipient opens the link from their email, without an account.
    const { owner } = fixtures();
    const link = await mailLink(owner.email, '?t=');
    const recipient = await browser.newContext();
    const view = await recipient.newPage();
    try {
      await view.goto(link);
      await expect(view).toHaveURL(/\/credentials\/[0-9a-f-]+$/); // the token left the address bar
      await expect(view.getByRole('heading', { level: 1, name: achievement.name })).toBeVisible();
      await expect(view.getByRole('heading', { name: 'This is your badge' })).toBeVisible();
      await expect(
        view.getByText('Signature checked with a key published by the issuer'),
      ).toBeVisible();
      await expectAccessible(view, 'credential page (recipient)', { schemes: ['light'] });

      // The baked badge carries a credential that verifies on its own.
      const credentialUrl = view.url();
      const png = await view.request.get(`${credentialUrl}/badge.png`);
      expect(png.headers()['content-type']).toBe('image/png');
      const baked = JSON.parse(extractFromPng(await png.body()) ?? 'null');
      expect(baked?.id).toBe(credentialUrl);
      const result = await verifyCredential(baked, {
        resolveController: verifierFetch(view.request),
        loadStatusListCredential: verifierFetch(view.request),
      });
      expect(result.checks.proof.outcome).toBe('passed');
      expect(result.checks.status.outcome).toBe('passed');
      expect(result.verified).toBe(true);
      // SVG artwork: a baked SVG too.
      const svg = await view.request.get(`${credentialUrl}/badge.svg`);
      expect(await svg.text()).toContain('<openbadges:credential>');

      await view.goto(`${credentialUrl}/certificate`);
      await expect(view.getByRole('heading', { level: 1, name: achievement.name })).toBeVisible();
      await expectAccessible(view, 'certificate', { schemes: ['light'] });

      // Hide the page: others get "not found", the recipient still sees it.
      await view.goto(credentialUrl);
      await view.getByRole('button', { name: 'Hide the page' }).click();
      await expect(view.getByRole('button', { name: 'Make the page public' })).toBeVisible();
      const stranger = await browser.newContext();
      try {
        const response = await (await stranger.newPage()).goto(credentialUrl);
        expect(response?.status()).toBe(404);
      } finally {
        await stranger.close();
      }
      await view.getByRole('button', { name: 'Make the page public' }).click();
      await expect(view.getByRole('button', { name: 'Hide the page' })).toBeVisible();
    } finally {
      await recipient.close();
    }
  });

  test('awarded badges and a badge’s delivery status', async ({ page }) => {
    const { org, credentialId } = fixtures();
    await openScreen(page, `/app/orgs/${org.id}/credentials`, 'Awarded badges');
    await expectAccessible(page, 'awarded badges');

    await openScreen(page, `/app/orgs/${org.id}/credentials/${credentialId}`, 'E2E Owner');
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await expectAccessible(page, 'credential delivery');
  });

  test('an award refused while the org waits for approval', async ({ page }) => {
    const { org, achievement, runId } = fixtures();
    await openScreen(
      page,
      `/app/orgs/${org.id}/award?achievementId=${achievement.id}`,
      'Award a badge',
    );
    await page.getByLabel('Recipient’s name').fill('Not A Member');
    await page.getByLabel('Recipient’s email address').fill(testEmail(runId, 'stranger'));
    await page.getByRole('button', { name: 'Award badge' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Not awarded' })).toBeVisible();
    await expectAccessible(page, 'award refused');
  });
});

test.describe('public pages', () => {
  test('the achievement page', async ({ page }) => {
    const { achievement } = fixtures();
    await page.goto(`/achievements/${achievement.id}`);
    await expect(page.getByRole('heading', { level: 1, name: achievement.name })).toBeVisible();
    await expectAccessible(page, 'achievement page', { schemes: ['light'] });
  });

  test('the credential page, as anyone sees it', async ({ page }) => {
    const { credentialId, achievement } = fixtures();
    await page.goto(`/credentials/${credentialId}`);
    await expect(page.getByRole('heading', { level: 1, name: achievement.name })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'This is your badge' })).toHaveCount(0);
    await expectAccessible(page, 'credential page (public)', { schemes: ['light'] });
  });
});
