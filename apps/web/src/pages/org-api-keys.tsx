import {
  API_KEY_SCOPE_LABELS,
  API_KEY_SCOPES,
  type ApiKey,
  type ApiKeyScope,
  type CreatedApiKey,
  createApiKeyInput,
} from '@credforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../components/app-shell';
import { ConfirmButton } from '../components/confirm';
import { isWritable, OrgStatusBanner } from '../components/org-status';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Alert, Badge, Spinner } from '../components/ui/feedback';
import { Field, Input, Select } from '../components/ui/input';
import { ApiError, del, errorMessage, post, queries } from '../lib/api';
import { formatDate, formatDateTime } from '../lib/utils';

/** What a new key may do by default: award badges and read what it needs for that. */
const DEFAULT_SCOPES: ApiKeyScope[] = ['achievement:read', 'credential:read', 'credential:issue'];

const EXPIRY_OPTIONS = [
  { value: '', label: 'Never' },
  { value: '30', label: 'In 30 days' },
  { value: '90', label: 'In 90 days' },
  { value: '365', label: 'In 1 year' },
];

function keyState(key: ApiKey): { label: string; variant: 'success' | 'neutral' | 'danger' } {
  if (key.revokedAt) return { label: 'Revoked', variant: 'danger' };
  if (key.expiresAt && new Date(key.expiresAt) <= new Date()) {
    return { label: 'Expired', variant: 'neutral' };
  }
  return { label: 'Active', variant: 'success' };
}

/** The new key, shown once. Focus moves to its heading so it's announced and easy to copy. */
function NewKey({ created, onDone }: { created: CreatedApiKey; onDone: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => heading.current?.focus(), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle ref={heading} tabIndex={-1} className="focus-visible:outline-none">
          Copy your new key now
        </CardTitle>
        <CardDescription>
          This is the only time “{created.name}” is shown in full. credforge keeps only a hash of
          it, so it can’t be shown again. If it’s lost, revoke it and create another.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Field label="API key">
          {(props) => (
            <Input
              {...props}
              readOnly
              value={created.key}
              className="font-mono"
              onFocus={(event) => event.currentTarget.select()}
            />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={copy}>
            Copy key
          </Button>
          <Button type="button" variant="outline" onClick={onDone}>
            I’ve stored it safely
          </Button>
          {copied && (
            <span role="status" className="text-sm text-muted-foreground">
              Copied.
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Send it as <code className="font-mono">Authorization: Bearer {created.prefix}_…</code>.
        </p>
      </CardContent>
    </Card>
  );
}

function CreateKeyForm({
  orgId,
  onCreated,
}: {
  orgId: string;
  onCreated: (key: CreatedApiKey) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(DEFAULT_SCOPES);
  const [expiry, setExpiry] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: (body: unknown) => post<CreatedApiKey>(`/orgs/${orgId}/api-keys`, body),
    onSuccess: async (created) => {
      setName('');
      setScopes(DEFAULT_SCOPES);
      setExpiry('');
      onCreated(created);
      await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'api-keys'] });
    },
    onError: (failure) => {
      if (failure instanceof ApiError) setErrors(failure.fieldErrors);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = { name, scopes, expiresInDays: expiry ? Number(expiry) : null };
    const parsed = createApiKeyInput.safeParse(body);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    create.mutate(body);
  }

  function toggle(scope: ApiKeyScope, on: boolean) {
    setScopes((current) =>
      on
        ? API_KEY_SCOPES.filter((s) => s === scope || current.includes(s))
        : current.filter((s) => s !== scope),
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-5" noValidate>
      {create.isError &&
        !(create.error instanceof ApiError && create.error.code === 'validation_failed') && (
          <Alert variant="error">{errorMessage(create.error)}</Alert>
        )}
      <Field
        label="Name"
        description="What uses it, so you know which key to revoke later."
        error={errors.name}
        className="sm:max-w-md"
      >
        {(props) => (
          <Input
            {...props}
            value={name}
            maxLength={100}
            placeholder="e.g. LMS integration"
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      <fieldset
        className="grid gap-3"
        aria-describedby={errors.scopes ? 'scopes-error' : undefined}
      >
        <legend className="mb-1 text-sm font-semibold">What it may do</legend>
        {API_KEY_SCOPES.map((scope) => (
          <label key={scope} className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={scopes.includes(scope)}
              onChange={(event) => toggle(scope, event.target.checked)}
              className="mt-0.5 size-4 accent-[var(--color-link)]"
            />
            <span>
              <span className="font-semibold">{API_KEY_SCOPE_LABELS[scope]}</span>
              <span className="block font-mono text-xs text-muted-foreground">{scope}</span>
            </span>
          </label>
        ))}
        {errors.scopes && (
          <p id="scopes-error" className="text-sm font-medium text-destructive">
            {errors.scopes}
          </p>
        )}
      </fieldset>
      <Field label="Expires" error={errors.expiresInDays} className="sm:max-w-xs">
        {(props) => (
          <Select {...props} value={expiry} onChange={(event) => setExpiry(event.target.value)}>
            {EXPIRY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" pending={create.isPending} className="justify-self-start">
        Create key
      </Button>
    </form>
  );
}

function KeyList({ orgId, keys }: { orgId: string; keys: ApiKey[] }) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/orgs/${orgId}/api-keys/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['org', orgId, 'api-keys'] }),
  });

  if (keys.length === 0) {
    return <p className="text-sm text-muted-foreground">No API keys yet.</p>;
  }
  return (
    <div className="grid gap-4">
      {revoke.isError && <Alert variant="error">{errorMessage(revoke.error)}</Alert>}
      <ul className="divide-y">
        {keys.map((key) => {
          const state = keyState(key);
          return (
            <li key={key.id} className="grid gap-2 py-4 sm:grid-cols-[1fr_auto] sm:items-start">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{key.name}</span>
                  <Badge variant={state.variant}>{state.label}</Badge>
                </p>
                <p className="mt-1 font-mono text-sm wrap-anywhere">{key.prefix}_…</p>
                <p className="mt-1 text-sm text-muted-foreground">{key.scopes.join(', ')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Created {formatDate(key.createdAt)}
                  {key.createdBy && ` by ${key.createdBy.name}`}
                  {' · '}
                  {key.lastUsedAt ? `last used ${formatDateTime(key.lastUsedAt)}` : 'never used'}
                  {key.expiresAt && !key.revokedAt && ` · expires ${formatDate(key.expiresAt)}`}
                  {key.revokedAt && ` · revoked ${formatDate(key.revokedAt)}`}
                </p>
              </div>
              {!key.revokedAt && (
                <ConfirmButton
                  variant="outline"
                  size="sm"
                  question={`Revoke ${key.name}? It stops working at once.`}
                  confirmLabel="Revoke key"
                  pending={revoke.isPending && revoke.variables === key.id}
                  onConfirm={() => revoke.mutate(key.id)}
                >
                  Revoke
                </ConfirmButton>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function OrgApiKeysPage({ orgId }: { orgId: string }) {
  const { data: org } = useQuery(queries.org(orgId));
  const canManage = org?.permissions.includes('api_key:manage') ?? false;
  const keys = useQuery({ ...queries.apiKeys(orgId), enabled: canManage });
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  if (!org) return <Spinner />;

  return (
    <>
      <PageHeader
        icon={KeyRound}
        title="API keys"
        description={
          <>
            Let your own systems award and read badges through the{' '}
            <a href="/api/docs" className="text-link underline underline-offset-4">
              credforge API
            </a>
            .
          </>
        }
      />
      <OrgStatusBanner org={org} />
      {!canManage ? (
        <Alert variant="info">Owners and admins manage API keys.</Alert>
      ) : (
        <div className="grid gap-6">
          {created ? (
            <NewKey created={created} onDone={() => setCreated(null)} />
          ) : (
            isWritable(org) && (
              <Card>
                <CardHeader>
                  <CardTitle>Create a key</CardTitle>
                  <CardDescription>
                    A key acts for this organization with only the permissions you choose. Keep it
                    secret, like a password.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <CreateKeyForm orgId={orgId} onCreated={setCreated} />
                </CardContent>
              </Card>
            )
          )}
          <Card>
            <CardHeader>
              <CardTitle>Keys</CardTitle>
              <CardDescription>
                Changes made with a key are recorded in the audit log under the key’s name.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {keys.isPending ? (
                <Spinner />
              ) : keys.isError ? (
                <Alert variant="error">{errorMessage(keys.error)}</Alert>
              ) : (
                <KeyList orgId={orgId} keys={keys.data.apiKeys} />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
