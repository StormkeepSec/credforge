import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { AuthLayout, ProviderButtons } from '../components/auth-layout';
import { Button } from '../components/ui/button';
import { Alert } from '../components/ui/feedback';
import { Field, Input } from '../components/ui/input';
import { queries } from '../lib/api';
import { authClient, authErrorMessage, oauthErrorMessage } from '../lib/auth-client';
import { safeRedirect } from '../lib/utils';

export function LoginPage({
  search,
}: {
  search: { redirect?: string; error?: string; email?: string };
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: instance } = useQuery(queries.instance());
  const [email, setEmail] = useState(search.email ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(
    search.error ? oauthErrorMessage(search.error) : null,
  );
  const [pending, setPending] = useState(false);
  const redirectTo = safeRedirect(search.redirect);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { data, error: failure } = await authClient.signIn.email({ email, password });
    setPending(false);
    if (failure) {
      setError(authErrorMessage(failure));
      return;
    }
    if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) {
      await navigate({ to: '/two-factor', search: { redirect: redirectTo } });
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    await navigate({ to: redirectTo });
  }

  return (
    <AuthLayout
      title="Sign in"
      description="Welcome back to credforge."
      footer={
        instance?.signupMode !== 'invite' && (
          <>
            New here?{' '}
            <Link
              to="/signup"
              search={{ redirect: search.redirect }}
              className="font-semibold text-link underline-offset-4 hover:underline"
            >
              Create an account
            </Link>
          </>
        )
      }
    >
      <div className="grid gap-5">
        {error && <Alert variant="error">{error}</Alert>}
        <ProviderButtons callbackURL={redirectTo} />
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <Field label="Email">
            {(props) => (
              <Input
                {...props}
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>
          <Field label="Password">
            {(props) => (
              <Input
                {...props}
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            )}
          </Field>
          <div className="flex items-center justify-between gap-4">
            <Link
              to="/forgot-password"
              search={{ email: email || undefined }}
              className="text-sm text-link underline-offset-4 hover:underline"
            >
              Forgot your password?
            </Link>
            <Button type="submit" pending={pending}>
              Sign in
            </Button>
          </div>
        </form>
      </div>
    </AuthLayout>
  );
}
