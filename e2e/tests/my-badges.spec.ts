import { type Browser, expect, test } from '@playwright/test';
import { BADGE_SVG, post, put, signUpAndConfirm } from '../support/accounts';
import { expectScreen, openScreen } from '../support/app';
import { expectAccessible } from '../support/axe';
import { fixtures, SIGNED_IN, SIGNED_OUT, testEmail } from '../support/fixtures';
import { LINKS, mailLink } from '../support/mailpit';

// My badges (design plan §8.8): a person who only receives badges signs up with the address they
// were sent to and lands on their own list; hiding a page, an extra address confirmed from its
// email, the badge's public page as its signed-in recipient, and the empty list.

/**
 * An approved organization of its own (so it can award to people outside it) with three
 * achievements, acting as the seeded owner. `close` when done.
 */
async function awardingOrg(browser: Browser, runId: string) {
  const owner = await browser.newContext({ storageState: SIGNED_IN.owner });
  const admin = await browser.newContext({ storageState: SIGNED_IN.admin });
  const close = async () => {
    await owner.close();
    await admin.close();
  };
  try {
    const name = `E2E Recipients ${runId}`;
    const org = await post<{ id: string }>(owner.request, '/api/v1/orgs', { name });
    await post(admin.request, `/api/v1/platform/orgs/${org.id}/approve`);
    const api = `/api/v1/orgs/${org.id}`;
    await post(owner.request, `${api}/issuers`, { name, url: 'https://example.org' });
    const achievement = async (title: string) => {
      const created = await post<{ id: string }>(owner.request, `${api}/achievements`, {
        name: `${title} ${runId}`,
        description: 'Awarded to check My badges.',
        criteriaNarrative: 'Took part in the end-to-end tests.',
      });
      await put(
        owner.request,
        `${api}/achievements/${created.id}/image`,
        BADGE_SVG,
        'image/svg+xml',
      );
      await post(owner.request, `${api}/achievements/${created.id}/publish`);
      return created.id;
    };
    const award = (achievementId: string, email: string) =>
      post<{ id: string }>(owner.request, `${api}/credentials`, {
        achievementId,
        recipient: { name: 'E2E Recipient', email },
        sendEmail: false,
      });
    const revoke = (id: string) =>
      post(owner.request, `${api}/credentials/${id}/revoke`, {
        reason: 'End-to-end test',
        publicReason: 'Awarded by mistake',
      });
    return {
      kept: await achievement('E2E Kept Badge'),
      revoked: await achievement('E2E Revoked Badge'),
      work: await achievement('E2E Work Badge'),
      award,
      revoke,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test('a recipient without an organization: My badges, hiding a page, an extra address', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const { runId, password } = fixtures();
  const email = testEmail(runId, 'recipient');
  const workEmail = testEmail(runId, 'recipient-work');
  const org = await awardingOrg(browser, runId);
  let kept = '';
  try {
    kept = (await org.award(org.kept, email)).id;
    const revoked = await org.award(org.revoked, email);
    await org.revoke(revoked.id);
    await org.award(org.work, workEmail);
  } finally {
    await org.close();
  }

  // Signing up with the address the badges went to; not a member of anything.
  await signUpAndConfirm(page.request, { name: 'E2E Recipient', email, password });
  await page.goto('/app');
  await expectScreen(page, 'My badges');
  const list = page.getByRole('list', { name: 'My badges' });
  const badge = (title: string) =>
    list.getByRole('article', { name: new RegExp(`^${title} ${runId}$`) });
  await expect(list.getByRole('article')).toHaveCount(2);
  await expect(badge('E2E Kept Badge').getByText('Valid', { exact: true })).toBeVisible();
  await expect(badge('E2E Revoked Badge').getByText('Revoked', { exact: true })).toBeVisible();
  await expect(badge('E2E Revoked Badge').getByText('Reason: Awarded by mistake')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create an organization' })).toBeVisible();
  await expectAccessible(page, 'my badges');

  // Hiding a page: it says so, and the button offers the way back.
  await badge('E2E Kept Badge').getByRole('button', { name: 'Hide its page' }).click();
  await expect(badge('E2E Kept Badge').getByText('Page hidden')).toBeVisible();
  await expect(
    badge('E2E Kept Badge').getByRole('button', { name: 'Make its page public' }),
  ).toBeVisible();
  await expectAccessible(page, 'my badges: a hidden page');

  // Its public page knows its recipient, signed in, even though it's hidden from everyone else.
  const response = await page.goto(`/credentials/${kept}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'This is your badge' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'My badges' })).toBeVisible();
  await expectAccessible(page, 'public badge page as its signed-in recipient', {
    schemes: ['light'],
  });
  const anonymous = await browser.newContext({ storageState: SIGNED_OUT });
  expect((await anonymous.request.get(`/credentials/${kept}`)).status()).toBe(404);
  await anonymous.close();

  // An extra address, confirmed from its email while signed in.
  await openScreen(page, '/app/settings', 'Account settings');
  await page.getByLabel('Add an address').fill(workEmail);
  await page.getByRole('button', { name: 'Send confirmation link' }).click();
  await expect(page.getByText(`We sent a link to ${workEmail}`)).toBeVisible();
  await expect(page.getByText('Waiting for confirmation')).toBeVisible();
  await expectAccessible(page, 'account settings: an address waiting for confirmation');

  await page.goto(await mailLink(workEmail, LINKS.confirmAddress, 60_000));
  await expectScreen(page, 'Address confirmed');
  // The token left the address bar.
  expect(new URL(page.url()).search).toBe('');
  await expectAccessible(page, 'address confirmed');

  await page.getByRole('link', { name: 'See my badges' }).click();
  await expectScreen(page, 'My badges');
  await expect(list.getByRole('article')).toHaveCount(3);
  await expect(badge('E2E Work Badge').getByText(`to ${workEmail}`)).toBeVisible();
  await expectAccessible(page, 'my badges: two addresses');
});

test('a new account with no badges yet', async ({ page }) => {
  const { runId, password } = fixtures();
  await signUpAndConfirm(page.request, {
    name: 'E2E Nobody',
    email: testEmail(runId, `nobadges-${Date.now().toString(36)}`),
    password,
  });
  await page.goto('/app');
  await expectScreen(page, 'My badges');
  await expect(page.getByText('No badges yet')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Award badges yourself' })).toBeVisible();
  await expectAccessible(page, 'my badges: none yet');

  await page.getByRole('link', { name: 'Create an organization' }).click();
  await expectScreen(page, 'Create an organization');

  // A confirmation link that isn't this account's (or isn't one at all).
  await page.goto('/confirm-email?token=not-a-real-token');
  await expectScreen(page, 'This link doesn’t work');
  await expect(page.getByRole('alert')).toBeVisible();
  await expectAccessible(page, 'confirm an address: a link that doesn’t work');
});

test('an address confirmation link opened signed out', async ({ page }) => {
  await page.goto('/confirm-email?token=not-a-real-token');
  await expectScreen(page, 'Sign in to confirm this address');
  // The token left the address bar; signing in comes back here.
  await expect(page).toHaveURL(/\/confirm-email$/);
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    /^\/login\?redirect=.*confirm-email/,
  );
  await expectAccessible(page, 'confirm an address: sign in first');
});
