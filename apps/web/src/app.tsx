import { useEffect, useState } from 'react';

type ServerStatus = 'checking' | 'ready' | 'unavailable';

// Placeholder screens until the issuer app is built (milestones M2–M4).
const screens: Record<string, { title: string; body: string }> = {
  '/login': {
    title: 'Sign in',
    body: 'Sign-in with email, Google or Microsoft arrives in milestone M2.',
  },
  '/signup': {
    title: 'Create your organization',
    body: 'Organization sign-up arrives in milestone M2.',
  },
};
const defaultScreen = {
  title: 'Issuer app',
  body: 'Creating achievements and awarding badges arrive in milestones M2 to M4.',
};

const statusText: Record<ServerStatus, { label: string; className: string }> = {
  checking: { label: 'Checking server…', className: 'text-ink-muted' },
  ready: { label: 'Server and database connected', className: 'text-success' },
  unavailable: { label: 'Server unavailable', className: 'text-danger' },
};

function useServerStatus(): ServerStatus {
  const [status, setStatus] = useState<ServerStatus>('checking');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/readyz', { signal: controller.signal })
      .then((response) => setStatus(response.ok ? 'ready' : 'unavailable'))
      .catch(() => {
        if (!controller.signal.aborted) setStatus('unavailable');
      });
    return () => controller.abort();
  }, []);
  return status;
}

export function App() {
  const status = statusText[useServerStatus()];
  const screen = screens[window.location.pathname] ?? defaultScreen;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-ink">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-4 sm:px-6">
          <a
            href="/"
            className="flex items-center gap-3 text-xl font-bold tracking-tight text-canvas"
          >
            <img src="/brand/credforge-mark-reverse.svg" alt="" className="size-9" />
            credforge
          </a>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-16 sm:px-6">
        <h1 className="text-4xl font-bold tracking-tight">{screen.title}</h1>
        <p className="mt-4 max-w-xl text-lg text-ink-muted">{screen.body}</p>
        <p className={`mt-10 text-sm font-semibold ${status.className}`} role="status">
          {status.label}
        </p>
      </main>
    </div>
  );
}
