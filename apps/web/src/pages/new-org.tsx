import { createOrgInput } from '@credforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Building2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { PageHeader } from '../components/app-shell';
import { InvitationsCard } from '../components/invitations-card';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Alert } from '../components/ui/feedback';
import { Field, Input } from '../components/ui/input';
import { ApiError, errorMessage, post, queries } from '../lib/api';

/**
 * Name your organization (onboarding step 3), or join one you were invited to. People who only
 * receive badges never need this: they start at My badges, one step away from here.
 */
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

  const firstOrg = (me?.memberships.length ?? 0) === 0;
  const onlyAdminsCreate = instance?.signupMode === 'invite' && !me?.user.isPlatformAdmin;

  return (
    <>
      <PageHeader
        title={firstOrg ? 'Create an organization' : 'New organization'}
        description="An organization is your team’s home on credforge. It owns your issuer profile, achievements and awards."
      />

      {me && <InvitationsCard me={me} className="mb-6" />}

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
