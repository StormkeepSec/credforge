import {
  type AccountEmail,
  addEmailInput,
  MAX_EXTRA_EMAILS,
  type SignInMethod,
} from '@credforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { KeyRound, Mail, ShieldCheck, UserCog } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { PageHeader } from '../components/app-shell';
import { PROVIDER_ICONS } from '../components/auth-layout';
import { ConfirmButton } from '../components/confirm';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Alert, Badge, Spinner } from '../components/ui/feedback';
import { Field, Input } from '../components/ui/input';
import { ApiError, del, errorMessage, post, queries } from '../lib/api';
import {
  authClient,
  authErrorMessage,
  oauthErrorMessage,
  PROVIDER_LABELS,
  type SocialProvider,
} from '../lib/auth-client';
import { formatDate, formatDateTime } from '../lib/utils';

/** Wraps a Better Auth client call so React Query sees its error as a thrown error. */
async function call<T>(
  promise: Promise<{ data: T | null; error: { code?: string; message?: string } | null }>,
) {
  const { data, error } = await promise;
  if (error) throw new Error(authErrorMessage(error));
  return data as T;
}

function ProfileCard({ name, email }: { name: string; email: string }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(name);
  const save = useMutation({
    mutationFn: () => call(authClient.updateUser({ name: value.trim() })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:max-w-md"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) save.mutate();
          }}
        >
          {save.isError && <Alert variant="error">{save.error.message}</Alert>}
          {save.isSuccess && <Alert variant="success">Saved.</Alert>}
          <Field label="Name">
            {(props) => (
              <Input {...props} value={value} onChange={(event) => setValue(event.target.value)} />
            )}
          </Field>
          <Field label="Email" description="Your sign-in address. Changing it isn’t available yet.">
            {(props) => <Input {...props} value={email} readOnly />}
          </Field>
          <Button type="submit" pending={save.isPending} className="justify-self-start">
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function MethodRow({
  icon,
  label,
  status,
  actions,
}: {
  icon: ReactNode;
  label: string;
  status: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-4">
      <div className="flex min-w-0 items-center gap-3 [&_svg]:size-5 [&_svg]:shrink-0">
        {icon}
        <div className="min-w-0">
          <p className="font-semibold break-all">{label}</p>
          <p className="text-sm text-muted-foreground">{status}</p>
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </li>
  );
}

/** Settings → Sign-in methods: explicit linking, since sign-in never merges accounts silently. */
function SignInMethodsCard({
  methods,
  email,
  error,
}: {
  methods: SignInMethod[];
  email: string;
  error?: string;
}) {
  const queryClient = useQueryClient();
  const { data: instance } = useQuery(queries.instance());
  const accountFor = (provider: string) => methods.find((method) => method.provider === provider);
  const providers = (['google', 'microsoft'] as const).filter(
    (id) => instance?.providers[id] || accountFor(id),
  );
  const hasPassword = Boolean(accountFor('credential'));
  const [resetSent, setResetSent] = useState(false);

  const unlink = useMutation({
    mutationFn: (accountId: string) => call(authClient.unlinkAccount({ accountId })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
  const setPassword = useMutation({
    mutationFn: () =>
      call(authClient.requestPasswordReset({ email, redirectTo: '/reset-password' })),
    onSuccess: () => setResetSent(true),
  });
  const connect = (provider: SocialProvider) =>
    authClient.linkSocial({
      provider,
      callbackURL: '/app/settings',
      errorCallbackURL: '/app/settings',
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign-in methods</CardTitle>
        <CardDescription>
          Ways to sign in to this account. A Google or Microsoft account must use {email} to
          connect.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-2">
        {error && (
          <Alert variant="error" className="mb-2">
            {oauthErrorMessage(error)}
          </Alert>
        )}
        {unlink.isError && (
          <Alert variant="error" className="mb-2">
            {unlink.error.message}
          </Alert>
        )}
        {setPassword.isError && (
          <Alert variant="error" className="mb-2">
            {setPassword.error.message}
          </Alert>
        )}
        <ul className="divide-y">
          <MethodRow
            icon={<KeyRound aria-hidden="true" />}
            label="Password"
            status={
              hasPassword ? 'Set' : resetSent ? `We emailed ${email} a link to set one.` : 'Not set'
            }
            actions={
              !hasPassword &&
              !resetSent && (
                <Button
                  variant="outline"
                  size="sm"
                  pending={setPassword.isPending}
                  onClick={() => setPassword.mutate()}
                >
                  Set a password
                </Button>
              )
            }
          />
          {providers.map((provider) => {
            const connected = accountFor(provider);
            const Icon = PROVIDER_ICONS[provider];
            return (
              <MethodRow
                key={provider}
                icon={<Icon />}
                label={PROVIDER_LABELS[provider]}
                status={connected ? <Badge variant="success">Connected</Badge> : 'Not connected'}
                actions={
                  connected
                    ? methods.length > 1 && (
                        <ConfirmButton
                          variant="outline"
                          size="sm"
                          question={`Stop signing in with ${PROVIDER_LABELS[provider]}?`}
                          confirmLabel="Disconnect"
                          pending={unlink.isPending}
                          onConfirm={() => unlink.mutate(connected.id)}
                        >
                          Disconnect
                        </ConfirmButton>
                      )
                    : instance?.providers[provider] && (
                        <Button variant="outline" size="sm" onClick={() => connect(provider)}>
                          Connect
                        </Button>
                      )
                }
              />
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Settings → Email addresses: more addresses whose badges show in My badges (design plan §8.8,
 * decision 52). Each is confirmed through a link emailed to it; none of them signs you in.
 */
function EmailAddressesCard({ email }: { email: string }) {
  const queryClient = useQueryClient();
  const emails = useQuery(queries.accountEmails());
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['me'] });

  const add = useMutation({
    mutationFn: (address: string) => post<AccountEmail>('/me/emails', { email: address }),
    onSuccess: async (added) => {
      setValue('');
      setSentTo(added.email);
      await refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError) setFieldError(error.fieldErrors.email);
    },
  });
  const resend = useMutation({
    mutationFn: (row: AccountEmail) => post<AccountEmail>(`/me/emails/${row.id}/resend`),
    onSuccess: async (row) => {
      setSentTo(row.email);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/me/emails/${id}`),
    onSuccess: async () => {
      setSentTo(null);
      await refresh();
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = addEmailInput.safeParse({ email: value });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message);
      return;
    }
    setFieldError(undefined);
    add.mutate(parsed.data.email);
  }

  const rows = emails.data?.emails ?? [];
  const failure = [add, resend, remove].find(
    (mutation) => mutation.isError && !(mutation === add && fieldError),
  )?.error;
  return (
    <Card id="email-addresses">
      <CardHeader>
        <CardTitle>Email addresses for My badges</CardTitle>
        <CardDescription>
          Badges awarded to any of these addresses show in My badges, once the address is confirmed.
          Only {email} signs you in.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 pt-2">
        {failure && <Alert variant="error">{errorMessage(failure)}</Alert>}
        {sentTo && (
          <Alert variant="success" title={`We sent a link to ${sentTo}`}>
            Open it while signed in to this account to confirm the address. It works for 24 hours.
          </Alert>
        )}
        <ul className="divide-y">
          <MethodRow
            icon={<Mail aria-hidden="true" />}
            label={email}
            status={<Badge variant="success">Sign-in address, confirmed</Badge>}
          />
          {rows.map((row) => (
            <MethodRow
              key={row.id}
              icon={<Mail aria-hidden="true" />}
              label={row.email}
              status={
                row.verifiedAt ? (
                  <Badge variant="success">Confirmed {formatDate(row.verifiedAt)}</Badge>
                ) : (
                  `Waiting for confirmation${row.sentAt ? `: link sent ${formatDateTime(row.sentAt)}` : ''}`
                )
              }
              actions={
                <>
                  {!row.verifiedAt && (
                    <Button
                      variant="outline"
                      size="sm"
                      pending={resend.isPending && resend.variables?.id === row.id}
                      onClick={() => resend.mutate(row)}
                    >
                      Send the link again
                    </Button>
                  )}
                  <ConfirmButton
                    variant="outline"
                    size="sm"
                    question={`Remove ${row.email}? Its badges leave My badges.`}
                    confirmLabel="Remove"
                    pending={remove.isPending && remove.variables === row.id}
                    onConfirm={() => remove.mutate(row.id)}
                  >
                    Remove
                  </ConfirmButton>
                </>
              }
            />
          ))}
        </ul>
        {rows.length < MAX_EXTRA_EMAILS ? (
          <form onSubmit={onSubmit} className="grid gap-4 sm:max-w-md" noValidate>
            <Field
              label="Add an address"
              description="We’ll email it a link to confirm it’s yours."
              error={fieldError}
            >
              {(props) => (
                <Input
                  {...props}
                  type="email"
                  autoComplete="email"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              )}
            </Field>
            <Button type="submit" pending={add.isPending} className="justify-self-start">
              Send confirmation link
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            You can add up to {MAX_EXTRA_EMAILS} addresses. Remove one to add another.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ChangePasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const change = useMutation({
    mutationFn: () =>
      call(
        authClient.changePassword({
          currentPassword: current,
          newPassword: next,
          revokeOtherSessions: true,
        }),
      ),
    onSuccess: () => {
      setCurrent('');
      setNext('');
    },
  });
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    change.mutate();
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>Signs you out on your other devices.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 sm:max-w-md" noValidate>
          {change.isError && <Alert variant="error">{change.error.message}</Alert>}
          {change.isSuccess && <Alert variant="success">Password changed.</Alert>}
          <Field label="Current password">
            {(props) => (
              <Input
                {...props}
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
              />
            )}
          </Field>
          <Field label="New password" description="At least 10 characters.">
            {(props) => (
              <Input
                {...props}
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(event) => setNext(event.target.value)}
              />
            )}
          </Field>
          <Button type="submit" pending={change.isPending} className="justify-self-start">
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function TwoFactorCard({
  enabled,
  required,
  hasPassword,
}: {
  enabled: boolean;
  required: boolean;
  hasPassword: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const body = hasPassword ? { password } : {};
  const disable = useMutation({
    mutationFn: () => call(authClient.twoFactor.disable(body)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      if (required) await navigate({ to: '/app/settings/two-factor' });
    },
  });
  const regenerate = useMutation({
    mutationFn: () => call(authClient.twoFactor.generateBackupCodes(body)),
    onSuccess: (data) => setCodes((data as { backupCodes: string[] }).backupCodes),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-step verification
          <Badge variant={enabled ? 'success' : 'neutral'}>{enabled ? 'On' : 'Off'}</Badge>
        </CardTitle>
        <CardDescription>
          {enabled
            ? 'credforge asks for a code from your authenticator app every time you sign in, with any method.'
            : 'Ask for a code from an authenticator app every time you sign in.'}
          {required && ' Required for owners and admins on this site.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!enabled ? (
          <Button asChild className="justify-self-start">
            <Link to="/app/settings/two-factor">Turn on</Link>
          </Button>
        ) : (
          <>
            {(disable.isError || regenerate.isError) && (
              <Alert variant="error">{(disable.error ?? regenerate.error)?.message}</Alert>
            )}
            {codes && (
              <Alert variant="success" title="New backup codes (your old ones no longer work)">
                <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-foreground sm:grid-cols-3">
                  {codes.map((code) => (
                    <li key={code}>{code}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {hasPassword && (
              <Field
                label="Password"
                description="Needed to change these settings."
                className="sm:max-w-sm"
              >
                {(props) => (
                  <Input
                    {...props}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                )}
              </Field>
            )}
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                pending={regenerate.isPending}
                onClick={() => regenerate.mutate()}
              >
                New backup codes
              </Button>
              <ConfirmButton
                variant="outline"
                question={
                  required
                    ? 'You’ll have to set it up again before continuing.'
                    : 'Turn off two-step verification?'
                }
                confirmLabel="Turn off"
                pending={disable.isPending}
                onConfirm={() => disable.mutate()}
              >
                Turn off
              </ConfirmButton>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function AccountSettingsPage({ search }: { search: { error?: string } }) {
  const { data: me } = useQuery(queries.me());
  if (!me) return <Spinner />;
  const hasPassword = me.signInMethods.some((method) => method.provider === 'credential');
  return (
    <>
      <PageHeader icon={UserCog} title="Account settings" description={me.user.email} />
      <div className="grid gap-6">
        <ProfileCard name={me.user.name} email={me.user.email} />
        <SignInMethodsCard methods={me.signInMethods} email={me.user.email} error={search.error} />
        <EmailAddressesCard email={me.user.email} />
        {hasPassword && <ChangePasswordCard />}
        <TwoFactorCard
          enabled={me.user.twoFactorEnabled}
          required={me.mfa.required}
          hasPassword={hasPassword}
        />
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          credforge never stores your Google or Microsoft access tokens; it only checks who signed
          in.
        </p>
      </div>
    </>
  );
}
