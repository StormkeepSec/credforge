import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@credforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { AuthLayout } from '../components/auth-layout';
import { Button } from '../components/ui/button';
import { Alert, Spinner } from '../components/ui/feedback';
import { errorMessage, post, queries } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { formatDate } from '../lib/utils';

/** `/invite/{token}`: the link in an invitation email. */
export function InvitePage({ token }: { token: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const preview = useQuery(queries.invitationPreview(token));
  const me = useQuery(queries.me());
  const here = `/invite/${token}`;

  const accept = useMutation({
    mutationFn: () =>
      post<{ org: { id: string } }>(`/invitations/${encodeURIComponent(token)}/accept`),
    onSuccess: async ({ org }) => {
      await queryClient.invalidateQueries();
      await navigate({ to: '/app/orgs/$orgId', params: { orgId: org.id } });
    },
  });

  if (preview.isPending || me.isPending) {
    return (
      <AuthLayout title="Invitation">
        <Spinner />
      </AuthLayout>
    );
  }
  if (preview.isError) {
    return (
      <AuthLayout title="This invitation can’t be used">
        <Alert variant="warning">
          The link is invalid, has expired or was already used. Ask the person who invited you to
          send a new one.
        </Alert>
      </AuthLayout>
    );
  }

  const invitation = preview.data;
  const user = me.data?.user;
  const signedInAsInvitee = user && user.email.toLowerCase() === invitation.email;
  const mfaPending = me.data && me.data.mfa.state !== 'ok';

  return (
    <AuthLayout
      title={`Join ${invitation.org.name}`}
      description={
        <>
          {invitation.invitedByName ? `${invitation.invitedByName} invited you` : 'You’re invited'}{' '}
          to join <strong className="text-foreground">{invitation.org.name}</strong> on credforge as{' '}
          <strong className="text-foreground">{ROLE_LABELS[invitation.role]}</strong>.
        </>
      }
    >
      <div className="grid gap-5 text-sm">
        <dl className="grid gap-3 rounded-lg bg-muted p-4">
          <div>
            <dt className="font-semibold">Role</dt>
            <dd className="text-muted-foreground">{ROLE_DESCRIPTIONS[invitation.role]}</dd>
          </div>
          <div>
            <dt className="font-semibold">For</dt>
            <dd className="text-muted-foreground">{invitation.email}</dd>
          </div>
          <div>
            <dt className="font-semibold">Expires</dt>
            <dd className="text-muted-foreground">{formatDate(invitation.expiresAt)}</dd>
          </div>
        </dl>

        {accept.isError && <Alert variant="error">{errorMessage(accept.error)}</Alert>}

        {!user && (
          <div className="grid gap-3">
            <p>Sign in or create an account with {invitation.email} to accept.</p>
            <Button asChild>
              <Link to="/signup" search={{ email: invitation.email, redirect: here }}>
                Create an account
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/login" search={{ email: invitation.email, redirect: here }}>
                Sign in
              </Link>
            </Button>
          </div>
        )}

        {user && !signedInAsInvitee && (
          <div className="grid gap-3">
            <Alert variant="warning" title="Signed in with another address">
              You’re signed in as {user.email}. This invitation is for {invitation.email}.
            </Alert>
            <Button
              variant="outline"
              onClick={async () => {
                await authClient.signOut();
                queryClient.clear();
                await navigate({
                  to: '/login',
                  search: { email: invitation.email, redirect: here },
                });
              }}
            >
              Sign out and switch accounts
            </Button>
          </div>
        )}

        {signedInAsInvitee && me.data?.mfa.state === 'challenge' && (
          <Button asChild>
            <Link to="/two-factor" search={{ redirect: here }}>
              Continue with two-step verification
            </Link>
          </Button>
        )}
        {signedInAsInvitee && me.data?.mfa.state === 'setup' && (
          <Button asChild>
            <Link to="/app/settings/two-factor">Turn on two-step verification first</Link>
          </Button>
        )}

        {signedInAsInvitee && !mfaPending && (
          <Button onClick={() => accept.mutate()} pending={accept.isPending}>
            Accept and join {invitation.org.name}
          </Button>
        )}
      </div>
    </AuthLayout>
  );
}
