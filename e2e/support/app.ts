import { expect, type Page } from '@playwright/test';

/** Waits for a screen by its h1 and checks the document title names it (WCAG 2.4.2). */
export async function expectScreen(page: Page, heading: string) {
  await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
  await expect(page).toHaveTitle(`${heading} · credforge`);
}

export async function openScreen(page: Page, path: string, heading: string) {
  await page.goto(path);
  await expectScreen(page, heading);
}
