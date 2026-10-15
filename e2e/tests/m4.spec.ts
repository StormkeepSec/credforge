import { expect, test } from '@playwright/test';
import { expectScreen, openScreen } from '../support/app';
import { expectAccessible } from '../support/axe';
import { fixtures, SIGNED_IN, testEmail } from '../support/fixtures';

// M4: awarding many from a CSV file, searching and revoking, reissuing, and the /verify tool.

test.describe('as an organization owner', () => {
  test.use({ storageState: SIGNED_IN.owner });

  test('award many: upload, the column mapping, the validation report, progress and results', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { org, owner, runId, achievement } = fixtures();
    await openScreen(page, `/app/orgs/${org.id}/award/many`, 'Award many');
    await expect(page.getByRole('link', { name: 'Download the template' })).toBeVisible();
    await expectAccessible(page, 'award many');

    // A pending org: only members can be awarded, and the owner already holds the badge.
    const fileName = `e2e-${runId}.csv`;
    const csv = [
      'Full name,E-mail,Completion date,Cohort',
      `E2E Owner,${owner.email},,Fall`,
      `Somebody Else,${testEmail(runId, 'csv-stranger')},,Fall`,
      'No Address,not-an-email,,Fall',
      `E2E Owner Again,${owner.email},,Spring`,
    ].join('\n');
    await page.getByLabel('Achievement').selectOption({ label: achievement.name });
    await page.getByLabel('CSV file').setInputFiles({
      name: fileName,
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    await page.getByRole('button', { name: 'Upload and check' }).click();
    await expectScreen(page, fileName);
    await expect(page.getByLabel('Column “E-mail”')).toHaveValue('email');
    await expect(page.getByRole('heading', { name: 'Rows with problems (2)' })).toBeVisible();
    await expect(page.getByText('isn’t a valid email address')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'People who already hold this achievement (1)' }),
    ).toBeVisible();
    await expectAccessible(page, 'batch: validation report');

    // Keep the cohort out of the records, then award the owner again.
    await page.getByLabel('Column “Cohort”').selectOption('ignore');
    await expect(page.getByLabel('Column “Cohort”')).toHaveValue('ignore');
    await page.getByLabel('Award again to people who already hold it').check();
    const award = page.getByRole('button', { name: 'Award 1 badge' });
    await expect(award).toBeEnabled();
    await award.click();
    await page.getByRole('button', { name: 'Award', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Awarded', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('status').filter({ hasText: '1 badge awarded' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download the results (CSV)' })).toBeVisible();
    await expectAccessible(page, 'batch: results');

    // The badge it awarded, found through the batch filter.
    await page.getByRole('link', { name: 'See these badges' }).click();
    await expectScreen(page, 'Awarded badges');
    const items = page.getByRole('list', { name: 'Awarded badges' }).getByRole('listitem');
    await expect(items).toHaveCount(1);
    await expectAccessible(page, 'awarded badges: filtered by upload');

    // Select it: the bulk revoke panel.
    await page.getByRole('checkbox', { name: /^Select E2E Owner/ }).check();
    await expect(page.getByRole('heading', { name: 'Revoke 1 selected badge' })).toBeVisible();
    await expectAccessible(page, 'awarded badges: bulk revoke');
    await page.getByRole('button', { name: 'Clear the selection' }).click();

    // Its page: reissue and revoke.
    await items.first().getByRole('link').click();
    await expectScreen(page, 'E2E Owner');
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await page.getByRole('button', { name: 'Correct and reissue' }).click();
    await expect(page.getByRole('heading', { name: 'Reissue a corrected copy' })).toBeFocused();
    await expectAccessible(page, 'credential: reissue form');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Correct and reissue' })).toBeFocused();

    await page.getByRole('button', { name: 'Revoke badge' }).click();
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.getByLabel('Reason (for your organization)')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expectAccessible(page, 'credential: revoke without a reason');
    await page.getByLabel('Reason (for your organization)').fill('End-to-end test');
    await page.getByLabel('Public reason (optional)').fill('Awarded in a test');
    await page.getByRole('button', { name: 'Revoke badge' }).click();
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.getByText(/^Revoked on /)).toBeVisible();
    await expect(page.getByText('Replaced by a corrected copy')).toHaveCount(0);
    await expectAccessible(page, 'credential: revoked');

    // The public page says so.
    const url = await page
      .getByRole('definition')
      .filter({ hasText: '/credentials/' })
      .textContent();
    if (!url) throw new Error('No credential URL on the page');
    await page.goto(new URL(url).pathname);
    await expect(page.getByText('Revoked on')).toBeVisible();
    await expect(page.getByText('Reason given by the issuer: Awarded in a test')).toBeVisible();
    await expect(page.getByText('End-to-end test')).toHaveCount(0);
    await expectAccessible(page, 'credential page (revoked)', { schemes: ['light'] });
  });

  test('awarded badges: search and filters', async ({ page }) => {
    const { org } = fixtures();
    await openScreen(page, `/app/orgs/${org.id}/credentials?q=E2E&status=valid`, 'Awarded badges');
    await expect(page.getByRole('searchbox', { name: 'Name or email' })).toHaveValue('E2E');
    await expect(page.getByLabel('Status')).toHaveValue('valid');
    await expect(page.getByRole('link', { name: 'CSV' })).toHaveAttribute(
      'href',
      `/api/v1/orgs/${org.id}/exports/credentials.csv?q=E2E&status=valid`,
    );
    await expectAccessible(page, 'awarded badges: search');

    await page.getByRole('searchbox', { name: 'Name or email' }).fill('nobody-matches-this');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByText('Nothing matches')).toBeVisible();
    await expectAccessible(page, 'awarded badges: no results');
  });
});

test.describe('the verification tool', () => {
  test('the form, a checked credential, and nothing to check', async ({ page }) => {
    const { credentialId } = fixtures();
    await page.goto('/verify');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Check an Open Badges 3.0 credential' }),
    ).toBeVisible();
    await expectAccessible(page, 'verify', { schemes: ['light'] });

    const url = new URL(`/credentials/${credentialId}`, page.url()).toString();
    await page.getByLabel('The credential’s address').fill(url);
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByRole('heading', { name: 'Every check passed' })).toBeVisible();
    await expectAccessible(page, 'verify: result', { schemes: ['light'] });

    await page.goto('/verify');
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByRole('alert')).toContainText('Nothing was checked');
    await expectAccessible(page, 'verify: nothing to check', { schemes: ['light'] });
  });

  test('a link that checks a credential straight away', async ({ page, request }) => {
    const { credentialId } = fixtures();
    // The URL the credential itself names (PUBLIC_BASE_URL), as a badge page would link it.
    const document = await (
      await request.get(`/credentials/${credentialId}`, { headers: { accept: 'application/json' } })
    ).json();
    await page.goto(`/verify?url=${encodeURIComponent(document.id)}`);
    await expect(page.getByRole('heading', { name: 'Every check passed' })).toBeVisible();
    await expect(
      page.getByText('Signature checked with a key published by the issuer'),
    ).toBeVisible();
    await expectAccessible(page, 'verify: linked check', { schemes: ['light'] });
  });
});
