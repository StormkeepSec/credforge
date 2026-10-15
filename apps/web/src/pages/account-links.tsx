import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { CheckCircle2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { AuthLayout } from '../components/auth-layout';
import { Button } from '../components/ui/button';
import { Alert } from '../components/ui/feedback';
import { Field, Input } from '../components/ui/input';
import { authClient, authErrorMessage } from '../lib/auth-client';
import { safeRedirect } from '../lib/utils';

const linkClass = 'font-semibold text-link underline-offset-4 hover:underline';

/**
 * Where the email confirmation link lands (`/verify-email`), with `?error=` if the link was
 * expired or invalid. Also lets people ask for a new link.
 */
export function VerifyEmailPage({
  search,
}: {
  search: { error?: string; email?: string; resend?: boolean };
}) {
  const failed = Boolean(search.error) || search.resend;
  const [email, setEmail] = useState(search.email ?? '');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function resend(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error: failure } = await authClient.sendVerificationEmail({
      email,
      callbackURL: '/verify-email',
    });
    setPending(false);
    if (failure) setError(authErrorMessage(failure));
    else setSent(true);
  }

  if (!failed) {
    return (
      <AuthLayout title="Email confirmed">
        <div className="grid gap-5 text-sm">
          <CheckCircle2 className="size-10 text-ok" aria-hidden="true" />
          <p>Thanks. Your email address is confirmed and you’re signed in.</p>
          <Button asChild>
            <Link to="/app">Continue</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={search.resend ? 'Send a new link' : 'That link didn’t work'}
      description={
        search.resend
          ? 'We’ll email you a new link to confirm your address.'
          : 'Confirmation links work once, for 24 hours. Ask for a new one below.'
      }
      footer={
        <Link to="/login" className={linkClass}>
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <Alert variant="success" title="Check your inbox">
          If an account with that address is waiting for confirmation, a new link is on its way.
        </Alert>
      ) : (
        <form onSubmit={resend} className="grid gap-4" noValidate>
          {error && <Alert variant="error">{error}</Alert>}
          <Field label="Email">
            {(props) => (
              <Input
                {...props}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>
          <Button type="submit" pending={pending}>
            Send a new link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ForgotPasswordPage({ search }: { search: { email?: string } }) {
  const [email, setEmail] = useState(search.email ?? '');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error: failure } = await authClient.requestPasswordReset({
      email,
      redirectTo: '/reset-password',
    });
    setPending(false);
    if (failure) setError(authErrorMessage(failure));
    else setSent(true);
  }

  return (
    <AuthLayout
      title="Set a new password"
      description="Enter your email address and we’ll send you a link. This also works if you’ve only signed in with Google or Microsoft so far."
      footer={
        <Link to="/login" className={linkClass}>
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <Alert variant="success" title="Check your inbox">
          If there’s a credforge account for {email}, we sent it a link. It works for one hour.
        </Alert>
      ) : (
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          {error && <Alert variant="error">{error}</Alert>}
          <Field label="Email">
            {(props) => (
              <Input
                {...props}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>
          <Button type="submit" pending={pending}>
            Send link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage({ search }: { search: { token?: string; error?: string } }) {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(
    search.error || !search.token
      ? 'This link is invalid or has expired. Ask for a new one.'
      : null,
  );
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 10) {
      setError('Use at least 10 characters.');
      return;
    }
    setPending(true);
    setError(null);
    const { error: failure } = await authClient.resetPassword({
      newPassword: password,
      token: search.token ?? '',
    });
    setPending(false);
    if (failure) setError(authErrorMessage(failure));
    else setDone(true);
  }

  return (
    <AuthLayout title={done ? 'Password updated' : 'Choose a new password'}>
      {done ? (
        <div className="grid gap-4">
          <Alert variant="success">
            You were signed out everywhere. Sign in with your new password.
          </Alert>
          <Button asChild>
            <Link to="/login">Sign in</Link>
          </Button>
        </div>
      ) : !search.token ? (
        // Without a token there's nothing to submit: offer the way to get one instead of a form.
        <div className="grid gap-4">
          <Alert variant="error">{error}</Alert>
          <Button asChild>
            <Link to="/forgot-password">Get a new link</Link>
          </Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          {error && <Alert variant="error">{error}</Alert>}
          <Field label="New password" description="At least 10 characters.">
            {(props) => (
              <Input
                {...props}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            )}
          </Field>
          <Button type="submit" pending={pending}>
            Save password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

/**
 * The second step of sign-in (after a password), and the credforge second factor after
 * Google or Microsoft sign-in (design plan §6.4).
 */
export function TwoFactorPage({ search }: { search: { redirect?: string } }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const trimmed = code.replace(/\s/g, '');
    const { error: failure } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code: trimmed })
      : await authClient.twoFactor.verifyTotp({ code: trimmed });
    setPending(false);
    if (failure) {
      setError(authErrorMessage(failure));
      return;
    }
    await queryClient.invalidateQueries();
    await navigate({ to: safeRedirect(search.redirect) });
  }

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: '/login' });
  }

  return (
    <AuthLayout
      title="Two-step verification"
      description={
        useBackup
          ? 'Enter one of the backup codes you saved when you turned on two-step verification. Each works once.'
          : 'Enter the 6-digit code from your authenticator app.'
      }
      footer={
        <button type="button" onClick={signOut} className={linkClass}>
          Sign in with another account
        </button>
      }
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        {error && <Alert variant="error">{error}</Alert>}
        <Field label={useBackup ? 'Backup code' : 'Code'}>
          {(props) => (
            <Input
              {...props}
              autoComplete="one-time-code"
              inputMode={useBackup ? 'text' : 'numeric'}
              autoFocus
              className="font-mono text-lg tracking-widest"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" pending={pending}>
          Verify
        </Button>
        <button
          type="button"
          className="justify-self-start text-sm text-link underline-offset-4 hover:underline"
          onClick={() => {
            setUseBackup(!useBackup);
            setCode('');
            setError(null);
          }}
        >
          {useBackup ? 'Use your authenticator app instead' : 'Use a backup code instead'}
        </button>
      </form>
    </AuthLayout>
  );
}
