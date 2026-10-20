import type { AccountEmail } from '@credforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AuthLayout } from '../components/auth-layout';
import { Button } from '../components/ui/button';
import { Alert, Spinner } from '../components/ui/feedback';
import { errorMessage, post, queries } from '../lib/api';

const linkClass = 'font-semibold text-link underline-offset-4 hover:underline';
const PATH = '/confirm-email';
/** Keeps the token while the person signs in, so it needn't stay in the address bar. */
const TOKEN_KEY = 'credforge.confirm-email';

function storedToken(): string | undefined {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeToken(token: string | undefined) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the token only lives in this page, which is fine if already signed in.
  }
}

/**
 * Where the link confirming an extra address lands (`/confirm-email?token=`, design plan §8.8).
 * It confirms the address for the account signed in now; signed out, it asks to sign in first
 * and comes back here. The token leaves the address bar at once.
 */
export function ConfirmEmailPage({ search }: { search: { token?: string } }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token] = useState(() => search.token ?? storedToken());
  const me = useQuery(queries.me());
  const started = useRef(false);
  const confirm = useMutation({
    mutationFn: () => post<AccountEmail>('/me/emails/confirm', { token }),
    onSettled: () => storeToken(undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  useEffect(() => {
    if (!search.token) return;
    storeToken(search.token);
    void navigate({ to: PATH, search: {}, replace: true });
  }, [search.token, navigate]);

  const ready = me.data?.user.emailVerified && me.data.mfa.state === 'ok';
  useEffect(() => {
    if (ready && token && !started.current) {
      started.current = true;
      confirm.mutate();
    }
  }, [ready, token, confirm]);

  if (!token) {
    return (
      <AuthLayout
        title="This link is incomplete"
        description="Open the link from the email again, or send a new one from Account settings."
      >
        <Button asChild>
          <Link to="/app/settings">Account settings</Link>
        </Button>
      </AuthLayout>
    );
  }
  if (me.isPending) {
    return (
      <AuthLayout title="Confirm this address">
        <Spinner />
      </AuthLayout>
    );
  }
  if (!me.data?.user.emailVerified) {
    return (
      <AuthLayout
        title="Sign in to confirm this address"
        description="Sign in to the credforge account that added this address. We’ll confirm it right after."
      >
        <Button asChild className="w-full">
          <Link to="/login" search={{ redirect: PATH }}>
            Sign in
          </Link>
        </Button>
      </AuthLayout>
    );
  }
  if (me.data.mfa.state !== 'ok') {
    return (
      <AuthLayout
        title="Finish signing in"
        description="Enter your two-step verification code first. We’ll confirm the address right after."
      >
        <Button asChild className="w-full">
          {me.data.mfa.state === 'challenge' ? (
            <Link to="/two-factor" search={{ redirect: PATH }}>
              Continue
            </Link>
          ) : (
            <Link to="/app/settings/two-factor">Set up two-step verification</Link>
          )}
        </Button>
      </AuthLayout>
    );
  }
  if (confirm.isError) {
    return (
      <AuthLayout
        title="This link doesn’t work"
        footer={
          <Link to="/app/settings" hash="email-addresses" className={linkClass}>
            Back to Account settings
          </Link>
        }
      >
        <Alert variant="error">{errorMessage(confirm.error)}</Alert>
      </AuthLayout>
    );
  }
  if (confirm.isSuccess) {
    return (
      <AuthLayout title="Address confirmed">
        <div className="grid gap-5 text-sm">
          <CheckCircle2 className="size-10 text-ok" aria-hidden="true" />
          <p>
            Badges awarded to <strong className="break-all">{confirm.data.email}</strong> now show
            in My badges.
          </p>
          <Button asChild>
            <Link to="/app/badges">See my badges</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Confirm this address">
      <Spinner label="Confirming" />
    </AuthLayout>
  );
}
