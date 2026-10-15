import { expect, test } from '@playwright/test';
import { openScreen } from '../support/app';
import { expectAccessible, WIDTHS } from '../support/axe';
import { fixtures, SIGNED_IN } from '../support/fixtures';

// Keyboard behaviour that regressed before (see the M2 accessibility review).

test.use({ storageState: SIGNED_IN.owner });

test.describe('the mobile menu', () => {
  test.use({ viewport: { width: WIDTHS.mobile, height: 812 } });

  test('takes focus, keeps Tab inside, labels its org switcher, and Escape closes it', async ({
    page,
  }) => {
    const { org } = fixtures();
    await openScreen(page, `/app/orgs/${org.id}`, org.name);

    // The header is inert while the panel is open, so find its button by CSS, not by role.
    const menuButton = page.locator('header button[aria-label="Open menu"]');
    await menuButton.focus();
    await page.keyboard.press('Enter');
    const panelId = await menuButton.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    const panel = page.locator(`[id="${panelId}"]`);
    await expect(panel.getByRole('button', { name: 'Close menu' })).toBeFocused();

    // Everything behind the panel is inert.
    for (const behind of ['a[href="#main"]', 'header', 'main']) {
      await expect(page.locator(behind)).toHaveAttribute('inert', '');
    }

    // The panel's org switcher has its own label (it once pointed at the hidden desktop copy).
    await expect(panel.getByRole('combobox', { name: 'Organization' })).toBeVisible();

    // Tab and Shift+Tab never reach anything outside the panel, and cycle through all of it.
    const focusable = 'a[href], button:not([disabled]), select, input, textarea';
    const controls = await panel.evaluate(
      (element, selector) => element.querySelectorAll(selector).length,
      focusable,
    );
    const reached = new Set<number>();
    const presses = [...Array(controls * 2 + 2).fill('Tab'), 'Shift+Tab', 'Shift+Tab'];
    for (const key of presses) {
      await page.keyboard.press(key);
      const focus = await panel.evaluate((element, selector) => {
        const active = document.activeElement;
        return {
          inside: Boolean(active && element.contains(active)),
          // Focus may briefly leave the document (to the browser) between the last and first.
          left: !active || active === document.body,
          index: active ? [...element.querySelectorAll(selector)].indexOf(active) : -1,
          what: active ? `${active.tagName} ${active.textContent?.trim().slice(0, 40)}` : 'none',
        };
      }, focusable);
      expect(focus.inside || focus.left, `${key} moved focus outside the menu: ${focus.what}`).toBe(
        true,
      );
      if (focus.index >= 0) reached.add(focus.index);
    }
    expect(reached.size, 'Tab should reach every control in the menu').toBe(controls);

    await expectAccessible(page, 'mobile menu open', { widths: [WIDTHS.mobile] });

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeFocused();
    await expect(page.locator('main')).not.toHaveAttribute('inert');
  });
});

test('cancelling a confirm button returns focus to it', async ({ page }) => {
  const { org, pendingInviteEmail } = fixtures();
  await openScreen(page, `/app/orgs/${org.id}/members`, 'Members');
  const row = page.getByRole('listitem').filter({ hasText: pendingInviteEmail });

  await row.getByRole('button', { name: 'Revoke' }).focus();
  await page.keyboard.press('Enter');
  await expect(row.getByRole('status')).toHaveText('Cancel this invitation?');
  await expect(row.getByRole('button', { name: 'Cancel invitation' })).toBeFocused();

  await page.keyboard.press('Tab');
  // Checked before pressing Enter, so a focus bug can never confirm the revoke by accident.
  await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row.getByRole('button', { name: 'Revoke' })).toBeFocused();
});
