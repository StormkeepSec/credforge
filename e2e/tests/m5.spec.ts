import { expect, test } from '@playwright/test';
import { openScreen } from '../support/app';
import { expectAccessible } from '../support/axe';
import { fixtures, SIGNED_IN } from '../support/fixtures';

/** M5: API keys, domain verification, the report link, the landing and legal pages, API docs. */

test.describe('as an organization owner', () => {
  test.use({ storageState: SIGNED_IN.owner });

  test('API keys: create one, see it once, use it, revoke it', async ({ page, playwright }) => {
    const { org, runId } = fixtures();
    await openScreen(page, `/app/orgs/${org.id}/api-keys`, 'API keys');
    await expectAccessible(page, 'API keys');

    const name = `E2E ${runId}`;
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Award badges (one at a time or in batches)').check();
    await page.getByRole('button', { name: 'Create key' }).click();
    // The form is replaced by the key: focus moves to its heading.
    await expect(page.getByRole('heading', { name: 'Copy your new key now' })).toBeFocused();
    const key = await page.getByLabel('API key').inputValue();
    expect(key).toMatch(/^cf_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    await expectAccessible(page, 'API key shown once');

    // An integration: no cookies, just the key.
    const integration = await playwright.request.newContext({
      baseURL: page.url(),
      extraHTTPHeaders: { authorization: `Bearer ${key}` },
    });
    const listed = await integration.get(`/api/v1/orgs/${org.id}/credentials`);
    expect(listed.status()).toBe(200);
    expect((await integration.get(`/api/v1/orgs/${org.id}/members`)).status()).toBe(403);

    await page.getByRole('button', { name: 'I’ve stored it safely' }).click();
    const row = page.getByRole('listitem').filter({ hasText: name });
    await expect(row.getByText('Active', { exact: true })).toBeVisible();
    await expect(page.getByText(key)).toHaveCount(0);
    await row.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('button', { name: 'Revoke key' }).click();
    await expect(row.getByText('Revoked', { exact: true })).toBeVisible();
    await expectAccessible(page, 'API keys with a revoked key');

    expect((await integration.get(`/api/v1/orgs/${org.id}/credentials`)).status()).toBe(401);
    await integration.dispose();
  });

  test('issuer profile: website verification instructions', async ({ page }) => {
    const { org } = fixtures();
    await openScreen(page, `/app/orgs/${org.id}/issuer`, 'Issuer profile');
    const card = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Website verification' }) });
    await expect(card).toBeVisible();
    const start = card.getByRole('button', { name: 'Verify this domain' });
    if (await start.isVisible()) {
      await start.click();
      await expect(card.getByText('A DNS TXT record')).toBeVisible();
      await expect(card.getByText(/^credforge-verify=/).first()).toBeVisible();
    }
    await expectAccessible(page, 'issuer profile with website verification');
  });
});

test.describe('public pages', () => {
  test('the landing page', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Achievement deserves more than a moment.' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Explore digital badges' }).click();
    await expect(page).toHaveURL(/#why-badges$/);
    await expectAccessible(page, 'landing page', { schemes: ['light'] });
  });

  test('the privacy policy and terms, marked as drafts', async ({ page }) => {
    for (const [path, heading] of [
      ['/privacy', 'Privacy policy'],
      ['/terms', 'Terms of service'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.getByText('Draft for review: not in effect yet')).toBeVisible();
      await expectAccessible(page, heading, { schemes: ['light'] });
    }
  });

  test('"Report a problem" on a badge page, with the abuse address', async ({ page }) => {
    const { credentialId } = fixtures();
    await page.goto(`/credentials/${credentialId}`);
    // The form folds out on the page itself (moderation.spec.ts sends one).
    await page.getByText('Report a problem', { exact: true }).click();
    const form = page.locator(`form[action="/report/credential/${credentialId}"]`);
    await expect(form.getByRole('radio', { name: /Child sexual abuse/ })).toBeVisible();
    await expect(form.getByRole('link', { name: /^abuse@/ })).toHaveAttribute(
      'href',
      /^mailto:abuse@/,
    );
  });

  test('the API docs load under the page’s CSP', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) {
        violations.push(message.text());
      }
    });
    await page.goto('/api/docs');
    await expect(page.getByRole('heading', { name: /credforge API/ })).toBeVisible();
    await expect(page.getByText('/orgs/{orgId}/credentials').first()).toBeVisible();
    expect(violations).toEqual([]);
  });
});
