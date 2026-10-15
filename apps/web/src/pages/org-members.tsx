import {
  assignableRoles,
  canManageMember,
  inviteMemberInput,
  type Member,
  ORG_ROLES,
  type OrgRole,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
} from '@credforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ShieldCheck, Users } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { PageHeader } from '../components/app-shell';
import { ConfirmButton } from '../components/confirm';
import { isWritable, OrgStatusBanner } from '../components/org-status';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Alert, Badge, Spinner } from '../components/ui/feedback';
import { Field, Input, Select } from '../components/ui/input';
import { ApiError, del, errorMessage, patch, post, queries } from '../lib/api';
import { formatDate } from '../lib/utils';

function InviteForm({ orgId, roles }: { orgId: string; roles: readonly OrgRole[] }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>(
    roles.includes('issuer') ? 'issuer' : (roles[0] ?? 'viewer'),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sentTo, setSentTo] = useState<string | null>(null);

  const invite = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/invitations`, { email, role }),
    onSuccess: async () => {
      setSentTo(email.trim().toLowerCase());
      setEmail('');
      await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'invitations'] });
    },
    onError: (error) => {
      if (error instanceof ApiError) setErrors(error.fieldErrors);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSentTo(null);
    const parsed = inviteMemberInput.safeParse({ email, role });
    if (!parsed.success) {
      setErrors({ email: parsed.error.issues[0]?.message ?? 'Check the address' });
      return;
    }
    setErrors({});
    invite.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      {sentTo && (
        <Alert variant="success">Invitation sent to {sentTo}. It expires in 7 days.</Alert>
      )}
      {invite.isError && !errors.email && (
        <Alert variant="error">{errorMessage(invite.error)}</Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-start">
        <Field label="Email address" error={errors.email}>
          {(props) => (
            <Input
              {...props}
              type="email"
              placeholder="colleague@example.org"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <Field label="Role">
          {(props) => (
            <Select
              {...props}
              value={role}
              onChange={(event) => setRole(event.target.value as OrgRole)}
            >
              {roles.map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABELS[option]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {/* Top margin = label height + gap, so the button lines up with the fields. */}
        <Button type="submit" pending={invite.isPending} className="sm:mt-5.5">
          Send invitation
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</p>
    </form>
  );
}

function MemberRow({
  orgId,
  member,
  actorRole,
  isSelf,
  writable,
}: {
  orgId: string;
  member: Member;
  actorRole: OrgRole;
  isSelf: boolean;
  writable: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['org', orgId] });
  const changeRole = useMutation({
    mutationFn: (role: OrgRole) => patch(`/orgs/${orgId}/members/${member.id}`, { role }),
    onSuccess: async () => {
      await refresh();
      if (isSelf) await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/orgs/${orgId}/members/${member.id}`),
    onSuccess: async () => {
      if (isSelf) {
        await queryClient.invalidateQueries({ queryKey: ['me'] });
        await navigate({ to: '/app' });
      } else await refresh();
    },
  });
  const canChange = writable && canManageMember(actorRole, member.role);
  const roleOptions = ORG_ROLES.filter(
    (role) => role === member.role || canManageMember(actorRole, member.role, role),
  );
  const error = changeRole.error ?? remove.error;

  return (
    <li className="grid gap-3 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-semibold">
          <span className="truncate">{member.name}</span>
          {isSelf && <Badge>You</Badge>}
          {member.twoFactorEnabled && (
            <Badge variant="success" title="Two-step verification is on">
              <ShieldCheck className="size-3" aria-hidden="true" />
              2-step<span className="sr-only"> verification on</span>
            </Badge>
          )}
        </p>
        <p className="text-sm wrap-anywhere text-muted-foreground">{member.email}</p>
        {error && (
          <p className="mt-1 text-sm font-medium text-destructive">{errorMessage(error)}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canChange ? (
          <Select
            aria-label={`Role of ${member.name}`}
            value={member.role}
            className="w-36"
            disabled={changeRole.isPending}
            onChange={(event) => changeRole.mutate(event.target.value as OrgRole)}
          >
            {roleOptions.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </Select>
        ) : (
          <Badge>{ROLE_LABELS[member.role]}</Badge>
        )}
        {(isSelf || canChange) && (
          <ConfirmButton
            variant="outline"
            size="sm"
            pending={remove.isPending}
            question={isSelf ? 'Leave the organization?' : `Remove ${member.name}?`}
            confirmLabel={isSelf ? 'Leave' : 'Remove'}
            onConfirm={() => remove.mutate()}
          >
            {isSelf ? 'Leave' : 'Remove'}
          </ConfirmButton>
        )}
      </div>
    </li>
  );
}

function PendingInvitations({
  orgId,
  actorRole,
  writable,
}: {
  orgId: string;
  actorRole: OrgRole;
  writable: boolean;
}) {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery(queries.invitations(orgId));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['org', orgId, 'invitations'] });
  const resend = useMutation({
    mutationFn: (id: string) => post(`/orgs/${orgId}/invitations/${id}/resend`),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/orgs/${orgId}/invitations/${id}`),
    onSuccess: refresh,
  });
  if (isPending) return <Spinner />;
  const invitations = data?.invitations ?? [];
  if (invitations.length === 0)
    return <p className="text-sm text-muted-foreground">No open invitations.</p>;

  return (
    <ul className="divide-y">
      {invitations.map((invitation) => {
        const manageable = writable && assignableRoles(actorRole).includes(invitation.role);
        return (
          <li
            key={invitation.id}
            className="grid gap-2 py-4 sm:grid-cols-[1fr_auto] sm:items-center"
          >
            <div className="min-w-0">
              <p className="font-semibold wrap-anywhere">{invitation.email}</p>
              <p className="text-sm text-muted-foreground">
                {ROLE_LABELS[invitation.role]} · expires {formatDate(invitation.expiresAt)}
                {invitation.invitedBy && ` · invited by ${invitation.invitedBy.name}`}
              </p>
              {resend.isSuccess && resend.variables === invitation.id && (
                <p role="status" className="text-sm text-ok">
                  New link sent.
                </p>
              )}
            </div>
            {manageable && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  pending={resend.isPending && resend.variables === invitation.id}
                  onClick={() => resend.mutate(invitation.id)}
                >
                  Resend
                </Button>
                <ConfirmButton
                  variant="outline"
                  size="sm"
                  question="Cancel this invitation?"
                  confirmLabel="Cancel invitation"
                  pending={revoke.isPending && revoke.variables === invitation.id}
                  onConfirm={() => revoke.mutate(invitation.id)}
                >
                  Revoke
                </ConfirmButton>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Members, roles and invitations. */
export function OrgMembersPage({ orgId }: { orgId: string }) {
  const { data: org } = useQuery(queries.org(orgId));
  const { data: me } = useQuery(queries.me());
  const { data, isPending } = useQuery(queries.members(orgId));
  if (!org || !me) return <Spinner />;

  const writable = isWritable(org);
  const canInvite = org.permissions.includes('member:invite');
  const roles = assignableRoles(org.role);

  return (
    <>
      <PageHeader
        icon={Users}
        title="Members"
        description="Everyone in the organization and what they can do."
      />
      <OrgStatusBanner org={org} />
      <div className="grid gap-6">
        {canInvite && writable && (
          <Card>
            <CardHeader>
              <CardTitle>Invite someone</CardTitle>
              <CardDescription>
                They’ll get an email with a link. They can accept with any sign-in method that uses
                this address.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <InviteForm orgId={orgId} roles={roles} />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>People</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            {isPending ? (
              <Spinner />
            ) : (
              <ul className="divide-y">
                {data?.members.map((member) => (
                  <MemberRow
                    key={member.id}
                    orgId={orgId}
                    member={member}
                    actorRole={org.role}
                    isSelf={member.userId === me.user.id}
                    writable={writable}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {canInvite && (
          <Card>
            <CardHeader>
              <CardTitle>Open invitations</CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              <PendingInvitations orgId={orgId} actorRole={org.role} writable={writable} />
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
