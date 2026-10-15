import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { MailCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { AuthLayout, ProviderButtons } from '../components/auth-layout';
import { Button } from '../components/ui/button';
import { Alert } from '../components/ui/feedback';
import { Field, Input } from '../components/ui/input';
import { queries } from '../lib/api';
import { authClient, authErrorMessage } from '../lib/auth-client';
import { safeRedirect } from '../lib/utils';

const MIN_PASSWORD = 10;

export function SignupPage({ search }: { search: { redirect?: string; email?: string } }) {
  const { data: instance } = useQuery(queries.instance());
  const [name, setName] = useState('');
  const [email, setEmail] = useState(search.email ?? '');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const fieldErrors: Record<string, string> = {};
    if (!name.trim()) fieldErrors.name = 'Enter your name';
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) fieldErrors.email = 'Enter a valid email address';
    if (password.length < MIN_PASSWORD)
      fieldErrors.password = `Use at least ${MIN_PASSWORD} characters`;
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    setPending(true);
    setError(null);
    const { error: failure } = await authClient.signUp.email({
      name: name.trim(),
      email: email.trim(),
      password,
      callbackURL: '/verify-email',
    });
    setPending(false);
    if (failure) setError(authErrorMessage(failure));
    else setSentTo(email.trim());
  }

  if (sentTo) {
    return (
      <AuthLayout title="Check your inbox">
        <div className="grid gap-4 text-sm">
          <MailCheck className="size-10 text-link" aria-hidden="true" />
          <p>
            We sent a link to <strong>{sentTo}</strong>. Open it to confirm your email address and
            finish creating your account.
          </p>
          <p className="text-muted-foreground">
            Nothing there after a few minutes? Check your spam folder, or{' '}
            <Link
              to="/verify-email"
              search={{ email: sentTo, resend: true }}
              className="text-link underline"
            >
              send a new link
            </Link>
            .
          </p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      description="Then name your organization and set up how your badges are signed."
      footer={
        <>
          Already have an account?{' '}
          <Link
            to="/login"
            search={{ redirect: search.redirect }}
            className="font-semibold text-link underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </>
      }
    >
      <div className="grid gap-5">
        {instance?.signupMode === 'invite' && (
          <Alert variant="info" title="Invitation needed">
            New accounts on this credforge site are by invitation only. Use the address your
            invitation was sent to.
          </Alert>
        )}
        {error && <Alert variant="error">{error}</Alert>}
        <ProviderButtons callbackURL={safeRedirect(search.redirect)} />
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <Field label="Your name" error={errors.name}>
            {(props) => (
              <Input
                {...props}
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field label="Work email" error={errors.email}>
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
          <Field
            label="Password"
            description={`At least ${MIN_PASSWORD} characters.`}
            error={errors.password}
          >
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
          <Button type="submit" pending={pending} className="w-full">
            Create account
          </Button>
        </form>
      </div>
    </AuthLayout>
  );
}
