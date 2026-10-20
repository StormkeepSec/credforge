import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Download, ShieldCheck } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../components/app-shell';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Alert, Spinner } from '../components/ui/feedback';
import { Field, Input } from '../components/ui/input';
import { queries } from '../lib/api';
import { authClient, authErrorMessage } from '../lib/auth-client';

type Step =
  | { name: 'start' }
  | { name: 'scan'; uri: string; backupCodes: string[] }
  | { name: 'codes'; backupCodes: string[] };

function secretFrom(uri: string): string {
  return (
    new URL(uri).searchParams
      .get('secret')
      ?.replace(/(.{4})/g, '$1 ')
      .trim() ?? ''
  );
}

/** The entry's name in the app, with this site's host: "credforge (credforge.app)". */
function issuerFrom(uri: string): string {
  return new URL(uri).searchParams.get('issuer') ?? 'credforge';
}

function downloadCodes(codes: string[], email: string) {
  // Backup codes work only on the site that issued them: say which one.
  const blob = new Blob(
    [
      `credforge backup codes for ${email} on ${window.location.origin}\nEach code works once.\n\n${codes.join('\n')}\n`,
    ],
    { type: 'text/plain' },
  );
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `credforge-backup-codes-${window.location.hostname}.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * Turns on TOTP two-step verification: confirm the password (if the account has one), scan the
 * QR code, enter a code, then save the backup codes. Owners and admins land here first when the
 * instance requires it (REQUIRE_MFA_FOR_ADMINS).
 */
export function TwoFactorSetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useQuery(queries.me());
  const [step, setStep] = useState<Step>({ name: 'start' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The button that led here is gone once the step changes: put focus on the new step's heading.
  const stepHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (step.name !== 'start') stepHeading.current?.focus();
  }, [step.name]);
  if (!me) return <Spinner />;

  const hasPassword = me.signInMethods.some((method) => method.provider === 'credential');
  const required = me.mfa.state === 'setup';

  async function start(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { data, error: failure } = await authClient.twoFactor.enable(
      hasPassword ? { password } : {},
    );
    setPending(false);
    if (failure || !data || !('totpURI' in data) || !data.totpURI) {
      setError(authErrorMessage(failure));
      return;
    }
    setStep({ name: 'scan', uri: data.totpURI, backupCodes: data.backupCodes ?? [] });
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (step.name !== 'scan') return;
    setPending(true);
    setError(null);
    const { error: failure } = await authClient.twoFactor.verifyTotp({
      code: code.replace(/\s/g, ''),
    });
    setPending(false);
    if (failure) {
      setError(authErrorMessage(failure));
      return;
    }
    setStep({ name: 'codes', backupCodes: step.backupCodes });
  }

  async function finish() {
    await queryClient.invalidateQueries();
    await navigate({ to: '/app' });
  }

  if (me.user.twoFactorEnabled && step.name === 'start') {
    return (
      <>
        <PageHeader icon={ShieldCheck} title="Two-step verification" />
        <Alert variant="success" title="Two-step verification is on">
          Manage it in Account settings.
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        icon={ShieldCheck}
        title="Turn on two-step verification"
        description="After you sign in, credforge also asks for a code from an authenticator app on your phone."
      />
      {required && step.name !== 'codes' && (
        <Alert variant="warning" title="Required for your role" className="mb-6">
          {me.user.isPlatformAdmin ? 'Platform admins' : 'Owners and admins'} must use two-step
          verification on this credforge site, whichever way they sign in. Set it up to continue.
        </Alert>
      )}
      {error && (
        <Alert variant="error" className="mb-6">
          {error}
        </Alert>
      )}

      {step.name === 'start' && (
        <Card>
          <CardHeader>
            <CardTitle>1. Get an authenticator app</CardTitle>
            <CardDescription>
              Any TOTP app works, for example Google Authenticator, Microsoft Authenticator,
              1Password or Bitwarden.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={start} className="grid gap-4 sm:max-w-sm" noValidate>
              {hasPassword && (
                <Field label="Confirm your password">
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
              <Button type="submit" pending={pending} className="justify-self-start">
                Continue
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {step.name === 'scan' && (
        <Card>
          <CardHeader>
            <CardTitle ref={stepHeading} tabIndex={-1} className="outline-none">
              2. Scan this code with the app
            </CardTitle>
            <CardDescription>Then enter the 6-digit code the app shows.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 sm:grid-cols-[auto_1fr]">
            <div className="justify-self-start rounded-lg bg-white p-3">
              <QRCodeSVG value={step.uri} size={176} title="QR code for your authenticator app" />
            </div>
            <form onSubmit={verify} className="grid content-start gap-4" noValidate>
              <div className="text-sm">
                <p className="font-semibold">Can’t scan it?</p>
                <p className="text-muted-foreground">Enter this key in the app instead:</p>
                <p className="mt-1 font-mono text-xs break-all">{secretFrom(step.uri)}</p>
                <p className="mt-2 text-muted-foreground">
                  Name the entry <span className="font-medium">{issuerFrom(step.uri)}</span> so you
                  can tell it apart from other credforge sites.
                </p>
              </div>
              <Field label="Code from the app">
                {(props) => (
                  <Input
                    {...props}
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    className="max-w-40 font-mono text-lg tracking-widest"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                )}
              </Field>
              <Button type="submit" pending={pending} className="justify-self-start">
                Turn on
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {step.name === 'codes' && (
        <Card>
          <CardHeader>
            <CardTitle ref={stepHeading} tabIndex={-1} className="outline-none">
              3. Save your backup codes
            </CardTitle>
            <CardDescription>
              If you lose your phone, each of these codes signs you in once. Keep them somewhere
              safe, like a password manager. They won’t be shown again.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <ul className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-4 font-mono text-sm sm:grid-cols-3">
              {step.backupCodes.map((backupCode) => (
                <li key={backupCode}>{backupCode}</li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                onClick={() => downloadCodes(step.backupCodes, me.user.email)}
              >
                <Download aria-hidden="true" />
                Download
              </Button>
              <Button onClick={finish}>I’ve saved them</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
