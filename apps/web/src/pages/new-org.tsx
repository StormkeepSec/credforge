import { createOrgInput, ROLE_LABELS } from '@credforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Building2, Mail } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { PageHeader } from '../components/app-shell';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Alert } from '../components/ui/feedback';
import { Field, Input } from '../components/ui/input';
import { ApiError, errorMessage, post, queries } from '../lib/api';
import { formatDate } from '../lib/utils';

/** Name your organization (onboarding step 3), or join one you were invited to. */
export function NewOrgPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useQuery(queries.me());
  const { data: instance } = useQuery(queries.instance());
  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string>();

  const create = useMutation({
    mutationFn: (body: { name: string }) => post<{ id: string }>('/orgs', body),
    onSuccess: async (org) => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await navigate({ to: '/app/orgs/$orgId', params: { orgId: org.id } });
    },
    onError: (error) => {
      if (error instanceof ApiError) setFieldError(error.fieldErrors.name);
    },
  });

  const accept = useMutation({
    mutationFn: (id: string) => post<{ org: { id: string } }>(`/me/invitations/${id}/accept`),
    onSuccess: async ({ org }) => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await navigate({ to: '/app/orgs/$orgId', params: { orgId: org.id } });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = createOrgInput.safeParse({ name });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message);
      return;
    }
    setFieldError(undefined);
    create.mutate(parsed.data);
  }

  const invitations = me?.invitations ?? [];
  const firstOrg = (me?.memberships.length ?? 0) === 0;
  const onlyAdminsCreate = instance?.signupMode === 'invite' && !me?.user.isPlatformAdmin;

  return (
    <>
      <PageHeader
        title={firstOrg ? 'Welcome to credforge' : 'New organization'}
        description="An organization is your team’s home on credforge. It owns your issuer profile, achievements and awards."
      />

      {invitations.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>You’re invited</CardTitle>
            <CardDescription>Join an organization that invited {me?.user.email}.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {accept.isError && <Alert variant="error">{errorMessage(accept.error)}</Alert>}
            {invitations.map((invitation) => (
              <div
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
              >
                <div className="flex items-start gap-3">
                  <Mail className="mt-0.5 size-4 text-link" aria-hidden="true" />
                  <div>
                    <p className="font-semibold">{invitation.org.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {ROLE_LABELS[invitation.role]}
                      {invitation.invitedByName && ` · invited by ${invitation.invitedByName}`} ·
                      expires {formatDate(invitation.expiresAt)}
                    </p>
                  </div>
                </div>
                <Button
                  onClick={() => accept.mutate(invitation.id)}
                  pending={accept.isPending && accept.variables === invitation.id}
                >
                  Join
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {onlyAdminsCreate ? (
        <Alert variant="info" title="Organizations are created by invitation">
          On this credforge site, a platform admin creates organizations. Ask yours to invite you.
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="size-5 text-link" aria-hidden="true" />
              Name your organization
            </CardTitle>
            <CardDescription>
              {instance?.signupMode === 'approval' && !me?.user.isPlatformAdmin
                ? 'You can set everything up right away. A platform admin reviews new organizations before they can award badges to people outside the team.'
                : 'Use the name people know you by. You can change it later.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="grid gap-4 sm:max-w-md" noValidate>
              {create.isError && !fieldError && (
                <Alert variant="error">{errorMessage(create.error)}</Alert>
              )}
              <Field label="Organization name" error={fieldError}>
                {(props) => (
                  <Input
                    {...props}
                    placeholder="Example Cyber Academy"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                )}
              </Field>
              <Button type="submit" pending={create.isPending} className="justify-self-start">
                Create organization
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </>
  );
}
