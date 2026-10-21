import type { ReactNode } from 'react';
import { BrandMark } from './brand-mark';

export function SiteHeader() {
  return (
    <header className="bg-ink">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <a
          href="/"
          className="flex shrink-0 items-center gap-2 text-lg font-bold tracking-tight text-canvas focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal sm:gap-3 sm:text-xl"
        >
          <BrandMark variant="reverse" className="size-8 sm:size-9" />
          credforge
        </a>
        <nav
          aria-label="Account"
          className="flex items-center gap-4 text-sm whitespace-nowrap sm:gap-6"
        >
          <a href="/login" className="text-canvas/80 hover:text-canvas">
            Sign in
          </a>
          <a href="/signup" className="font-semibold tracking-wide text-spark hover:text-canvas">
            Get started
          </a>
        </nav>
      </div>
    </header>
  );
}

const FOOTER_LINKS = [
  { href: '/verify', label: 'Verify a badge' },
  { href: '/api/docs', label: 'API' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-ink/10">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-ink-muted sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div className="grid gap-1">
          <p className="font-bold tracking-wide text-ink">credforge</p>
          <p>Open source under the Apache-2.0 license.</p>
        </div>
        <nav aria-label="Site">
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            {FOOTER_LINKS.map((item) => (
              <li key={item.href}>
                <a href={item.href} className="underline underline-offset-4 hover:text-ink">
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}

export function SitePage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}

/**
 * The issuer's website, worded as precisely as the brand guardrails ask: "verified" only when the
 * issuer proved control of that host (§6.3), otherwise "self-reported".
 */
export function websiteLabel(
  website: string,
  verifiedHost: string | null,
): {
  host: string;
  verified: boolean;
} {
  let host = website;
  try {
    host = new URL(website).hostname;
  } catch {
    // Shown as given.
  }
  return { host, verified: verifiedHost !== null && verifiedHost === host };
}
