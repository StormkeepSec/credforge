import { expect, test } from '@playwright/test';
import { BADGE_SVG, post, put } from '../support/accounts';
import { expectScreen, openScreen } from '../support/app';
import { expectAccessible } from '../support/axe';
import { fixtures, SIGNED_IN } from '../support/fixtures';
import { trustOrg } from '../support/moderation';
import { BASE_URL } from '../support/stack';

// Erasing a recipient's data (design plan §12.1): what it covers, confirming in place, the
// erased badge in the issuer app, and its public page (410 Gone).

test.describe('as an organization owner', () => {
  test.use({ storageState: SIGNED_IN.owner });

  test('erase a recipient’s data: review, confirm, the erased badge and its public page', async ({
    page,
    playwright,
  }) => {
    test.setTimeout(120_000);
    const { owner, runId } = fixtures();
    // An organization of its own: erasing reaches every badge awarded to the address, and the
    // other tests use the seeded organization's badges (all to the owner's address).
    const request = page.request;
    const name = `E2E Erasure ${runId}`;
    const org = await post<{ id: string }>(request, '/api/v1/orgs', { name });
    // Its content is public at once, so the 410 page below can name the issuer (§6.5).
    const admin = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: SIGNED_IN.admin,
    });
    await trustOrg(admin, org.id);
    await admin.dispose();
    const api = `/api/v1/orgs/${org.id}`;
    await post(request, `${api}/issuers`, { name, url: 'https://example.org' });
    const achievement = await post<{ id: string }>(request, `${api}/achievements`, {
      name: `E2E Erasable ${runId}`,
      description: 'Awarded to be erased.',
      criteriaNarrative: 'Took part in the end-to-end tests.',
    });
    await put(request, `${api}/achievements/${achievement.id}/image`, BADGE_SVG, 'image/svg+xml');
    await post(request, `${api}/achievements/${achievement.id}/publish`);
    // A pending org awards only to its members, so the person is the owner's address.
    const award = () =>
      post<{ id: string }>(request, `${api}/credentials`, {
        achievementId: achievement.id,
        recipient: { name: 'Erin Erasure', email: owner.email },
        sendEmail: false,
      });
    const first = await award();
    const second = await award();

    await openScreen(page, `/app/orgs/${org.id}/credentials/${first.id}`, 'Erin Erasure');
    const review = page.getByRole('button', { name: 'Review what would be erased' });
    await expect(review).toBeVisible();
    await expectAccessible(page, 'credential: erase card');

    // What it covers: both badges to the address. Cancel hands focus back.
    await review.click();
    await expect(page.getByRole('heading', { name: 'Erase this person’s data' })).toBeFocused();
    await expect(page.getByRole('heading', { name: /^2 badges awarded to / })).toBeVisible();
    await expect(page.getByText('2 badges still valid will be revoked.')).toBeVisible();
    await expectAccessible(page, 'credential: what erasing covers');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(review).toBeFocused();

    // Confirmed in place.
    await review.click();
    await page.getByRole('button', { name: 'Erase Erin Erasure’s data' }).click();
    await expect(
      page.getByText('Erase Erin Erasure’s data from 2 badges? This can’t be undone.'),
    ).toBeVisible();
    await expectAccessible(page, 'credential: confirm erasing');
    await page.getByRole('button', { name: 'Erase permanently' }).click();

    // The badge is now a tombstone: focus moves to the notice that replaced the card.
    await expect(page.getByRole('heading', { name: /^Recipient’s data erased on / })).toBeFocused();
    await expectScreen(page, 'Recipient’s data erased');
    await expect(page.getByText('Erin Erasure')).toHaveCount(0);
    await expect(page.getByText('Revoked, data erased')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review what would be erased' })).toHaveCount(0);
    await expectAccessible(page, 'credential: erased');

    await openScreen(page, `/app/orgs/${org.id}/credentials`, 'Awarded badges');
    const items = page.getByRole('list', { name: 'Awarded badges' }).getByRole('listitem');
    await expect(items).toHaveCount(2);
    await expect(items.filter({ hasText: 'Recipient’s data erased' })).toHaveCount(2);
    await expectAccessible(page, 'awarded badges: erased');

    // Its public address answers 410 Gone, naming only the issuer and the achievement.
    const response = await page.goto(`/credentials/${second.id}`);
    expect(response?.status()).toBe(410);
    await expect(
      page.getByRole('heading', { level: 1, name: 'This badge is no longer available' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name })).toBeVisible();
    await expect(page.getByText('Erin Erasure')).toHaveCount(0);
    await expectAccessible(page, 'credential page (erased)', { schemes: ['light'] });
  });
});
