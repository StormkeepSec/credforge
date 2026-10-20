import { type MeResponse, ROLE_LABELS } from '@credforge/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Mail } from 'lucide-react';
import { errorMessage, post } from '../lib/api';
import { formatDate } from '../lib/utils';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Alert } from './ui/feedback';

/** Open invitations to the signed-in person's confirmed address, each with Join. */
export function InvitationsCard({ me, className }: { me: MeResponse; className?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accept = useMutation({
    mutationFn: (id: string) => post<{ org: { id: string } }>(`/me/invitations/${id}/accept`),
    onSuccess: async ({ org }) => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await navigate({ to: '/app/orgs/$orgId', params: { orgId: org.id } });
    },
  });

  if (me.invitations.length === 0) return null;
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>You’re invited</CardTitle>
        <CardDescription>Join an organization that invited {me.user.email}.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {accept.isError && <Alert variant="error">{errorMessage(accept.error)}</Alert>}
        {me.invitations.map((invitation) => (
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
  );
}
