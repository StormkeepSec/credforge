import { type AuditEvent, updateOrgInput } from '@credforge/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { PageHeader } from '../components/app-shell';
import { isWritable, OrgStatusBanner } from '../components/org-status';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Alert, Spinner } from '../components/ui/feedback';
import { Field, Input } from '../components/ui/input';
import { ApiError, errorMessage, fetchAuditPage, patch, queries } from '../lib/api';
import { formatDateTime } from '../lib/utils';

function RenameForm({ orgId, name }: { orgId: string; name: string }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string>();
  const rename = useMutation({
    mutationFn: (body: { name: string }) => patch(`/orgs/${orgId}`, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['org', orgId] });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (failure) => {
      if (failure instanceof ApiError) setError(failure.fieldErrors.name ?? failure.message);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = updateOrgInput.safeParse({ name: value });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    setError(undefined);
    rename.mutate(parsed.data);
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:max-w-md" noValidate>
      {rename.isSuccess && <Alert variant="success">Saved.</Alert>}
      <Field label="Organization name" error={error}>
        {(props) => (
          <Input {...props} value={value} onChange={(event) => setValue(event.target.value)} />
        )}
      </Field>
      <Button type="submit" pending={rename.isPending} className="justify-self-start">
        Save
      </Button>
    </form>
  );
}

/** `org.created` → "Org created". */
function describe(action: string): string {
  const text = action.replace(/[._]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function details(event: AuditEvent): string | null {
  const data = event.data as Record<string, unknown>;
  if (typeof data.email === 'string' && typeof data.role === 'string')
    return `${data.email} · ${data.role}`;
  if (typeof data.from === 'string' && typeof data.to === 'string') {
    return `${typeof data.email === 'string' ? `${data.email}: ` : ''}${data.from} → ${data.to}`;
  }
  if (typeof data.name === 'string') return data.name;
  const changed = Object.keys(data).filter(
    (key) => typeof data[key] === 'object' && data[key] !== null,
  );
  return changed.length > 0 ? `Changed: ${changed.join(', ')}` : null;
}

function AuditLog({ orgId }: { orgId: string }) {
  const log = useInfiniteQuery({
    queryKey: ['org', orgId, 'audit'],
    queryFn: ({ pageParam }) => fetchAuditPage(orgId, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.next ?? undefined,
  });
  if (log.isPending) return <Spinner />;
  if (log.isError) return <Alert variant="error">{errorMessage(log.error)}</Alert>;
  const events = log.data.pages.flatMap((page) => page.events);

  return (
    <div className="grid gap-4">
      <ol className="divide-y text-sm">
        {events.map((event) => (
          <li key={event.id} className="grid gap-1 py-3 sm:grid-cols-[11rem_1fr]">
            <time dateTime={event.createdAt} className="text-muted-foreground">
              {formatDateTime(event.createdAt)}
            </time>
            <div className="min-w-0">
              <p className="font-semibold">{describe(event.action)}</p>
              <p className="wrap-anywhere text-muted-foreground">
                {event.actor.label ?? event.actor.type}
                {details(event) && ` · ${details(event)}`}
              </p>
            </div>
          </li>
        ))}
      </ol>
      {log.hasNextPage && (
        <Button
          variant="outline"
          className="justify-self-start"
          pending={log.isFetchingNextPage}
          onClick={() => log.fetchNextPage()}
        >
          Show older
        </Button>
      )}
    </div>
  );
}

export function OrgSettingsPage({ orgId }: { orgId: string }) {
  const { data: org } = useQuery(queries.org(orgId));
  if (!org) return <Spinner />;
  const canRename = org.permissions.includes('org:update') && isWritable(org);
  const canAudit = org.permissions.includes('audit:read');

  return (
    <>
      <PageHeader icon={Settings} title="Organization settings" />
      <OrgStatusBanner org={org} />
      <div className="grid gap-6">
        {canRename && (
          <Card>
            <CardHeader>
              <CardTitle>Name</CardTitle>
              <CardDescription>
                The organization’s name inside credforge. The name on your badges comes from your
                issuer profile.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RenameForm key={org.name} orgId={orgId} name={org.name} />
            </CardContent>
          </Card>
        )}
        {canAudit ? (
          <Card>
            <CardHeader>
              <CardTitle>Audit log</CardTitle>
              <CardDescription>
                Every change in this organization, newest first. Entries can’t be edited or deleted.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-2">
              <AuditLog orgId={orgId} />
            </CardContent>
          </Card>
        ) : (
          !canRename && <Alert variant="info">Owners and admins manage these settings.</Alert>
        )}
      </div>
    </>
  );
}
