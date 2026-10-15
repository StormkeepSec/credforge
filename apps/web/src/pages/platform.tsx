import type { OrgStatus, PlatformOrg } from '@credforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '../components/app-shell';
import { OrgStatusBadge } from '../components/org-status';
import { Button } from '../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Alert, Spinner } from '../components/ui/feedback';
import { Field, Textarea } from '../components/ui/input';
import { errorMessage, post, queries } from '../lib/api';
import { cn, formatDate } from '../lib/utils';

const TABS: { status: OrgStatus | 'all'; label: string }[] = [
  { status: 'pending', label: 'Waiting' },
  { status: 'active', label: 'Approved' },
  { status: 'suspended', label: 'Suspended' },
  { status: 'declined', label: 'Declined' },
  { status: 'all', label: 'All' },
];

type Decision = 'approve' | 'decline' | 'suspend' | 'reinstate';

function OrgCard({ org }: { org: PlatformOrg }) {
  const queryClient = useQueryClient();
  const [reasonFor, setReasonFor] = useState<'decline' | 'suspend' | null>(null);
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (decision: Decision) =>
      post(`/platform/orgs/${org.id}/${decision}`, reasonFor ? { reason } : {}),
    onSuccess: async () => {
      setReasonFor(null);
      setReason('');
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {org.name}
          <OrgStatusBadge status={org.status} />
        </CardTitle>
        <CardDescription>
          Created {formatDate(org.createdAt)}
          {org.requestedBy && ` by ${org.requestedBy.name} (${org.requestedBy.email})`} ·{' '}
          {org.memberCount} {org.memberCount === 1 ? 'member' : 'members'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {org.issuers.length === 0 ? (
          <p className="text-muted-foreground">No issuer profile yet.</p>
        ) : (
          <ul className="grid gap-1">
            {org.issuers.map((issuer) => (
              <li key={issuer.id}>
                <span className="font-semibold">{issuer.name}</span>
                {issuer.website ? (
                  <>
                    {' · '}
                    <a
                      href={issuer.website}
                      target="_blank"
                      rel="noreferrer noopener nofollow"
                      className="text-link underline"
                    >
                      {new URL(issuer.website).host}
                    </a>{' '}
                    <span className="text-muted-foreground">
                      (self-reported, domain not verified)
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground"> · no website</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {org.statusReason && (
          <p className="text-muted-foreground">Reason given: {org.statusReason}</p>
        )}
        {decide.isError && <Alert variant="error">{errorMessage(decide.error)}</Alert>}
        {reasonFor && (
          <Field label={`Reason (shown to the organization’s owners)`}>
            {(props) => (
              <Textarea
                {...props}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>
        )}
      </CardContent>
      <CardFooter>
        {reasonFor ? (
          <>
            <Button
              variant="destructive"
              pending={decide.isPending}
              onClick={() => decide.mutate(reasonFor)}
            >
              {reasonFor === 'decline' ? 'Decline' : 'Suspend'}
            </Button>
            <Button variant="ghost" onClick={() => setReasonFor(null)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            {(org.status === 'pending' || org.status === 'declined') && (
              <Button pending={decide.isPending} onClick={() => decide.mutate('approve')}>
                Approve
              </Button>
            )}
            {org.status === 'pending' && (
              <Button variant="outline" onClick={() => setReasonFor('decline')}>
                Decline
              </Button>
            )}
            {(org.status === 'active' || org.status === 'pending') && (
              <Button variant="outline" onClick={() => setReasonFor('suspend')}>
                Suspend
              </Button>
            )}
            {org.status === 'suspended' && (
              <Button pending={decide.isPending} onClick={() => decide.mutate('reinstate')}>
                Reinstate
              </Button>
            )}
          </>
        )}
      </CardFooter>
    </Card>
  );
}

/** Platform admins: the approval queue and every organization on the instance (design plan §6.3). */
export function PlatformPage() {
  const [tab, setTab] = useState<OrgStatus | 'all'>('pending');
  const { data, isPending, isError, error } = useQuery(queries.platformOrgs(tab));

  return (
    <>
      <PageHeader
        icon={ShieldCheck}
        title="Platform"
        description="Approve new organizations before they can award badges to people outside their team."
      />
      <div
        role="tablist"
        aria-label="Organizations by status"
        className="mb-6 flex flex-wrap gap-2"
      >
        {TABS.map((item) => (
          <button
            key={item.status}
            type="button"
            role="tab"
            aria-selected={tab === item.status}
            onClick={() => setTab(item.status)}
            className={cn(
              'rounded-full border px-4 py-1.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring',
              tab === item.status
                ? 'border-primary bg-primary text-primary-foreground'
                : 'bg-card hover:bg-muted',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="grid gap-4">
        {isPending && <Spinner />}
        {isError && <Alert variant="error">{errorMessage(error)}</Alert>}
        {data?.orgs.length === 0 && (
          <p className="text-muted-foreground">
            {tab === 'pending' ? 'Nothing waiting for approval.' : 'No organizations here.'}
          </p>
        )}
        {data?.orgs.map((org) => (
          <OrgCard key={org.id} org={org} />
        ))}
      </div>
    </>
  );
}
