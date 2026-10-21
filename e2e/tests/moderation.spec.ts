import { type Browser, expect, type Page, test } from '@playwright/test';
import { BADGE_SVG, enableTwoFactor, post, put, signUpAndConfirm } from '../support/accounts';
import { expectScreen, openScreen } from '../support/app';
import { expectAccessible } from '../support/axe';
import { fixtures, SIGNED_IN, SIGNED_OUT, testEmail } from '../support/fixtures';

// Content moderation (design plan §6.5): an org's first content waiting for review on the
// Platform screen, the moderation queue with its blurred images and actions asked in place, and
// the "Report a problem" form on public pages, each screen checked with axe in light and dark at
// 1280 and 375 px.

/**
 * A new org with a logo and a published achievement: all of it waits for review. Its owner is an
 * account of its own (the seeded owner may have only three orgs waiting for approval).
 */
async function moderatedOrg(browser: Browser) {
  const { runId, password } = fixtures();
  const owner = await browser.newContext({ storageState: SIGNED_OUT });
  const request = owner.request;
  await signUpAndConfirm(request, {
    name: 'E2E Moderated Owner',
    email: testEmail(runId, 'moderated'),
    password,
  });
  const name = `E2E Moderation ${runId}`;
  const org = await post<{ id: string }>(request, '/api/v1/orgs', { name });
  // Owners turn on two-step verification before anything else (REQUIRE_MFA_FOR_ADMINS).
  await enableTwoFactor(request, password);
  const api = `/api/v1/orgs/${org.id}`;
  const issuer = await post<{ id: string }>(request, `${api}/issuers`, {
    name,
    url: 'https://example.org',
    description: 'Seeded by the end-to-end tests to be reviewed.',
  });
  await put(request, `${api}/issuers/${issuer.id}/logo`, BADGE_SVG, 'image/svg+xml');
  const achievement = await post<{ id: string }>(request, `${api}/achievements`, {
    name: `E2E Moderated ${runId}`,
    description: 'Waits for a platform admin before its page shows it.',
    criteriaNarrative: 'Took part in the end-to-end tests.',
    tags: ['review'],
  });
  await put(
    request,
    `${api}/achievements/${achievement.id}/image`,
    Buffer.from(BADGE_SVG.toString().replace('#379392', '#CA3CFF')),
    'image/svg+xml',
  );
  await post(request, `${api}/achievements/${achievement.id}/publish`);
  await owner.close();
  return { orgId: org.id, name, achievementId: achievement.id, issuerId: issuer.id };
}

/** Sends the report form folded into a public page (or on its own page). */
async function sendReport(page: Page, category: RegExp, details: string) {
  await page.getByRole('radio', { name: category }).check();
  await page.getByLabel('What should be looked at? (optional)').fill(details);
  // The form refuses what comes back faster than a person reads it (a few seconds).
  await page.waitForTimeout(3_500);
  await page.getByRole('button', { name: 'Send report' }).click();
}

test.describe('as a platform admin', () => {
  test.use({ storageState: SIGNED_IN.admin });

  test('review an org’s first content, the moderation queue and a report', async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    const org = await moderatedOrg(browser);

    // The public achievement page leaves the held content out.
    const visitor = await browser.newContext({ storageState: SIGNED_OUT });
    const publicPage = await visitor.newPage();
    await publicPage.goto(`/achievements/${org.achievementId}`);
    await expect(publicPage.getByRole('heading', { level: 1 })).toHaveText(
      'Achievement waiting for review',
    );
    await expect(publicPage.getByText(org.name)).toHaveCount(0);

    // Someone reports it from the page: the form folds out at its foot.
    await publicPage.getByText('Report a problem', { exact: true }).click();
    await expect(publicPage.getByRole('radio', { name: /Child sexual abuse/ })).toBeVisible();
    await expectAccessible(publicPage, 'achievement page: report form open');
    await sendReport(publicPage, /^Something else/, 'Checked by the end-to-end tests.');
    await expect(
      publicPage.getByRole('heading', { level: 1, name: 'Thank you, your report was sent' }),
    ).toBeVisible();
    await expectAccessible(publicPage, 'report sent');
    await visitor.close();

    // The Platform screen shows the new org's content with the approval.
    await openScreen(page, '/app/platform', 'Platform');
    const card = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: new RegExp(`^${org.name}`) }) })
      .first();
    const review = card.getByRole('region', { name: `${org.name}: content to review` });
    await expect(review.getByRole('img', { name: 'Blurred image' }).first()).toBeVisible();
    await expect(
      card.first().getByRole('button', { name: /^Approve and publish \d items$/ }),
    ).toBeVisible();
    await expectAccessible(page, 'platform: org waiting with its content');

    // The moderation queue.
    await openScreen(page, '/app/platform/moderation', 'Moderation');
    const image = page.getByRole('region', { name: /^Badge image · E2E Moderated/ });
    await expect(image.getByRole('img', { name: 'Blurred image' })).toBeVisible();
    await expectAccessible(page, 'moderation: waiting for review');

    // An image stays blurred until asked.
    await image.getByRole('button', { name: 'Show image' }).click();
    await expect(image.getByRole('img', { name: 'Badge image under review' })).toBeVisible();
    await expectAccessible(page, 'moderation: image shown');
    await image.getByRole('button', { name: 'Blur again' }).click();

    // Removing asks for a reason in place; Cancel hands focus back.
    await image.getByRole('button', { name: 'Remove image' }).click();
    await expect(image.getByLabel('Reason (emailed to the organization’s owners)')).toBeFocused();
    await expectAccessible(page, 'moderation: reason asked in place');
    await image.getByRole('button', { name: 'Cancel' }).click();
    await expect(image.getByRole('button', { name: 'Remove image' })).toBeFocused();

    // Clearing publishes it.
    await image.getByRole('button', { name: 'Clear and publish' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Badge image cleared and published.' }),
    ).toBeVisible();

    // The report, with what the page shows.
    await page.getByRole('button', { name: /^Reports/ }).click();
    const report = page
      .getByRole('region')
      .filter({ hasText: 'Checked by the end-to-end tests.' })
      .first();
    await expect(report.getByText('Checked by the end-to-end tests.')).toBeVisible();
    await expectAccessible(page, 'moderation: reports');
    await report.getByRole('button', { name: 'Resolve' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Report resolved.' })).toBeVisible();
    await page.getByRole('button', { name: 'Resolved reports' }).click();
    await expect(page.getByText('Checked by the end-to-end tests.').first()).toBeVisible();
    await expectAccessible(page, 'moderation: resolved reports');

    // Approving publishes the rest.
    await openScreen(page, '/app/platform', 'Platform');
    await page
      .getByRole('button', { name: /^Approve and publish \d items?$/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Approved', pressed: false }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: new RegExp(`^${org.name} Approved`) }),
    ).toBeVisible();
    await expectAccessible(page, 'platform: approved org with limits and trust');
    const anonymous = await browser.newContext({ storageState: SIGNED_OUT });
    const after = await anonymous.newPage();
    await after.goto(`/achievements/${org.achievementId}`);
    await expect(after.getByRole('heading', { level: 1 })).toHaveText(
      `E2E Moderated ${fixtures().runId}`,
    );
    await anonymous.close();
  });
});

test.describe('signed out', () => {
  test.use({ storageState: SIGNED_OUT });

  test('the report form on a page of its own: mistakes, then sent', async ({ page }) => {
    test.setTimeout(60_000);
    const { credentialId } = fixtures();
    await page.goto(`/report/credential/${credentialId}`);
    await expectScreen(page, 'Report a problem');
    await expectAccessible(page, 'report page');

    // Without a category the form comes back, saying so.
    await page.getByLabel('What should be looked at? (optional)').fill('No category chosen.');
    await page.waitForTimeout(3_500);
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByRole('alert')).toContainText('The report wasn’t sent');
    await expect(page.getByText('Choose what is wrong')).toBeVisible();
    await expectAccessible(page, 'report page: mistakes');

    await sendReport(page, /^Impersonation/, 'Sent by the end-to-end tests.');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Thank you, your report was sent' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to the page' })).toHaveAttribute(
      'href',
      new RegExp(`/credentials/${credentialId}$`),
    );
  });
});
