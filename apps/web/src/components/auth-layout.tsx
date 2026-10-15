import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef } from 'react';
import { queries } from '../lib/api';
import { authClient, PROVIDER_LABELS, type SocialProvider } from '../lib/auth-client';
import { useDocumentTitle } from '../lib/utils';
import { Wordmark } from './brand';
import { Button } from './ui/button';

/**
 * Centered single-card layout for sign-in, sign-up and the other account screens. When a screen
 * swaps its content for the next step (a new title), focus moves to the heading so screen reader
 * and keyboard users land on the new step instead of the top of the page.
 */
export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useDocumentTitle(title);
  const heading = useRef<HTMLHeadingElement>(null);
  const shownTitle = useRef(title);
  useEffect(() => {
    if (shownTitle.current === title) return;
    shownTitle.current = title;
    heading.current?.focus();
  }, [title]);

  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-10 sm:py-16">
      <header className="mb-8">
        <Wordmark to="/" />
      </header>
      <main className="w-full max-w-md">
        <div className="rounded-xl border bg-card p-6 shadow-xs sm:p-8">
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-bold tracking-tight outline-none"
          >
            {title}
          </h1>
          {description && <div className="mt-2 text-sm text-muted-foreground">{description}</div>}
          <div className="mt-6">{children}</div>
        </div>
        {footer && <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>}
      </main>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.5 5.5 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24Z"
      />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1Z" />
      <path
        fill="#EA4335"
        d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.5-3.5A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9Z"
      />
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
      <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
      <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
      <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
    </svg>
  );
}

export const PROVIDER_ICONS: Record<SocialProvider, () => ReactNode> = {
  google: GoogleIcon,
  microsoft: MicrosoftIcon,
};

/** "Continue with Google / Microsoft", for the providers this instance has configured. */
export function ProviderButtons({ callbackURL }: { callbackURL: string }) {
  const { data: instance } = useQuery(queries.instance());
  const providers = (['google', 'microsoft'] as const).filter((id) => instance?.providers[id]);
  if (providers.length === 0) return null;

  return (
    <div className="grid gap-3">
      {providers.map((provider) => {
        const Icon = PROVIDER_ICONS[provider];
        return (
          <Button
            key={provider}
            variant="outline"
            className="w-full"
            onClick={() =>
              authClient.signIn.social({
                provider,
                callbackURL,
                newUserCallbackURL: '/app',
                errorCallbackURL: '/login',
              })
            }
          >
            <Icon />
            Continue with {PROVIDER_LABELS[provider]}
          </Button>
        );
      })}
      <div className="my-2 flex items-center gap-3 text-xs text-muted-foreground uppercase">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}
