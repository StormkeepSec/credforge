import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/** WCAG 2.0, 2.1 and 2.2 at levels A and AA (design plan §11.3). */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export const WIDTHS = { desktop: 1280, mobile: 375 } as const;
const HEIGHTS: Record<number, number> = { 1280: 800, 375: 812 };

type Scheme = 'light' | 'dark';

interface Options {
  /** Viewport widths to check; default desktop and mobile. */
  widths?: number[];
  schemes?: Scheme[];
}

/** Waits for layout and any finite CSS transition or animation (a colour fade would skew contrast). */
async function settle(page: Page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await document.fonts.ready;
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

/**
 * Runs axe on the page as it is now, in light and dark (emulated `prefers-color-scheme`) at each
 * width, and fails the test (softly, so later states are still checked) on any WCAG A/AA
 * violation. Restores the viewport and colour scheme afterwards.
 */
export async function expectAccessible(page: Page, label: string, options: Options = {}) {
  const widths = options.widths ?? [WIDTHS.desktop, WIDTHS.mobile];
  const schemes = options.schemes ?? ['light', 'dark'];
  const viewport = page.viewportSize();

  await test.step(`axe: ${label}`, async () => {
    const problems: string[] = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: HEIGHTS[width] ?? 800 });
      for (const colorScheme of schemes) {
        await page.emulateMedia({ colorScheme });
        await settle(page);
        const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
        for (const violation of results.violations) {
          const nodes = violation.nodes.slice(0, 5).map((node) => {
            const summary = node.failureSummary?.split('\n').slice(1, 2).join(' ').trim();
            return `\n      ${node.target.join(' ')}${summary ? ` :: ${summary}` : ''}`;
          });
          problems.push(
            `${width}px ${colorScheme}: ${violation.id} (${violation.impact}, ${violation.nodes.length} nodes) ${violation.help}${nodes.join('')}`,
          );
        }
      }
    }
    expect.soft(problems, `axe found WCAG A/AA violations on "${label}"`).toEqual([]);
  });

  if (viewport) await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: 'light' });
}
