import type { CredentialDetails, CredentialSummary } from '@credforge/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Award, CheckCircle2, Circle, ExternalLink, Inbox, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageHeader } from '../components/app-shell';
import { ConfirmButton } from '../components/confirm';
import { DeliveryBadge } from '../components/delivery';
import { isWritable, OrgStatusBanner } from '../components/org-status';
import { Button } from '../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Alert, Badge, Spinner } from '../components/ui/feedback';
import { errorMessage, fetchCredentialPage, post, queries } from '../lib/api';
import { formatDate, formatDateTime } from '../lib/utils';

function StatusBadges({ credential }: { credential: CredentialSummary }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {credential.status === 'revoked' && <Badge variant="danger">Revoked</Badge>}
      <DeliveryBadge status={credential.delivery} />
      {credential.acceptedAt && <Badge variant="success">Opened</Badge>}
      {credential.visibility === 'hidden' && <Badge>Hidden by recipient</Badge>}
    </span>
  );
}

/** What was awarded, newest first, with each email's delivery status (design plan §8.4). */
export function CredentialsPage({ orgId }: { orgId: string }) {
  const { data: org } = useQuery(queries.org(orgId));
  const pages = useInfiniteQuery({
    queryKey: ['org', orgId, 'credentials'],
    queryFn: ({ pageParam }) => fetchCredentialPage(orgId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  if (!org || pages.isPending) return <Spinner />;
  const credentials = pages.data?.pages.flatMap((page) => page.credentials) ?? [];
  const canAward = isWritable(org) && org.permissions.includes('credential:issue');

  return (
    <>
      <PageHeader
        icon={Inbox}
        title="Awarded badges"
        description="Everything your organization has awarded, and whether the email arrived."
        actions={
          canAward && (
            <Button asChild>
              <Link to="/app/orgs/$orgId/award" params={{ orgId }}>
                Award a badge
              </Link>
            </Button>
          )
        }
      />
      <OrgStatusBanner org={org} />
      {pages.error && <Alert variant="error">{errorMessage(pages.error)}</Alert>}
      {credentials.length === 0 ? (
        <Card>
          <CardContent>
            <p className="font-semibold">Nothing awarded yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Badges you award show up here with their delivery status.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-3">
          {credentials.map((credential) => (
            <li key={credential.id}>
              <Link
                to="/app/orgs/$orgId/credentials/$credentialId"
                params={{ orgId, credentialId: credential.id }}
                className="grid gap-3 rounded-xl border bg-card p-4 hover:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:grid-cols-[3rem_1fr_auto] sm:items-center"
              >
                <div className="hidden size-12 items-center justify-center overflow-hidden rounded-lg bg-muted sm:flex">
                  {credential.achievement.image128 ? (
                    <img
                      src={credential.achievement.image128}
                      alt=""
                      className="size-full object-contain"
                    />
                  ) : (
                    <Award className="size-6 text-muted-foreground" aria-hidden="true" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="font-semibold break-words">{credential.recipient.name}</p>
                  <p className="text-sm break-all text-muted-foreground">
                    {credential.recipient.email}
                  </p>
                  <p className="mt-1 text-sm">
                    {credential.achievement.name}
                    <span className="text-muted-foreground">
                      {' · '}
                      {formatDate(credential.createdAt)}
                    </span>
                  </p>
                </div>
                <StatusBadges credential={credential} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {pages.hasNextPage && (
        <div className="mt-6">
          <Button
            variant="outline"
            onClick={() => pages.fetchNextPage()}
            pending={pages.isFetchingNextPage}
          >
            Show older
          </Button>
        </div>
      )}
    </>
  );
}

type StepState = 'done' | 'failed' | 'waiting';

function TimelineStep({
  state,
  title,
  children,
}: {
  state: StepState;
  title: string;
  children?: ReactNode;
}) {
  const Icon = state === 'done' ? CheckCircle2 : state === 'failed' ? XCircle : Circle;
  const color =
    state === 'done'
      ? 'text-ok'
      : state === 'failed'
        ? 'text-destructive'
        : 'text-muted-foreground';
  return (
    <li className="flex gap-3">
      <Icon className={`mt-0.5 size-5 shrink-0 ${color}`} aria-hidden="true" />
      <div>
        <p className="font-semibold">
          {title}
          <span className="sr-only">
            {state === 'done' ? ' (done)' : state === 'failed' ? ' (failed)' : ' (not yet)'}
          </span>
        </p>
        {children && <div className="text-sm text-muted-foreground">{children}</div>}
      </div>
    </li>
  );
}

/** The issued → emailed → delivered → opened timeline (design plan §11.1). */
function Timeline({ credential }: { credential: CredentialDetails }) {
  const email = credential.emails[0];
  const problem =
    email && ['bounced', 'dropped', 'failed', 'spam_reported'].includes(email.status)
      ? email
      : null;
  return (
    <ol className="grid gap-4">
      <TimelineStep state="done" title="Awarded">
        {formatDateTime(credential.createdAt)}
        {credential.issuedBy.label && ` by ${credential.issuedBy.label}`}
      </TimelineStep>
      {!email ? (
        <TimelineStep state="waiting" title="Not emailed">
          The recipient wasn’t sent a link. Use Send the link to email it.
        </TimelineStep>
      ) : (
        <>
          <TimelineStep
            state={email.sentAt ? 'done' : email.status === 'failed' ? 'failed' : 'waiting'}
            title={
              email.sentAt ? 'Emailed' : email.status === 'failed' ? 'Email failed' : 'Email queued'
            }
          >
            {email.sentAt
              ? `${formatDateTime(email.sentAt)} to ${email.to}`
              : email.status === 'failed'
                ? email.lastError
                : `To ${email.to}`}
          </TimelineStep>
          <TimelineStep
            state={problem ? 'failed' : email.deliveredAt ? 'done' : 'waiting'}
            title={
              problem
                ? problem.status === 'spam_reported'
                  ? 'Marked as spam'
                  : problem.status === 'failed'
                    ? 'Not delivered'
                    : problem.status === 'bounced'
                      ? 'Bounced'
                      : 'Not delivered'
                : email.deliveredAt
                  ? 'Delivered'
                  : 'Delivery not confirmed yet'
            }
          >
            {problem
              ? (problem.lastError ?? 'The recipient’s mail server refused it. Check the address.')
              : email.deliveredAt
                ? formatDateTime(email.deliveredAt)
                : 'Confirmed when the email provider reports it (SendGrid).'}
          </TimelineStep>
        </>
      )}
      <TimelineStep
        state={credential.acceptedAt ? 'done' : 'waiting'}
        title="Opened by the recipient"
      >
        {credential.acceptedAt
          ? formatDateTime(credential.acceptedAt)
          : 'When they first open the link in their email.'}
      </TimelineStep>
    </ol>
  );
}

export function CredentialDetailPage({
  orgId,
  credentialId,
}: {
  orgId: string;
  credentialId: string;
}) {
  const queryClient = useQueryClient();
  const { data: org } = useQuery(queries.org(orgId));
  const { data: credential, error, isPending } = useQuery(queries.credential(orgId, credentialId));
  const resend = useMutation({
    mutationFn: () => post<CredentialDetails>(`/orgs/${orgId}/credentials/${credentialId}/resend`),
    onSuccess: async (updated) => {
      queryClient.setQueryData(queries.credential(orgId, credentialId).queryKey, updated);
      await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'credentials'] });
    },
  });
  if (!org || isPending) return <Spinner />;
  if (error || !credential) return <Alert variant="error">{errorMessage(error)}</Alert>;
  const canSend =
    isWritable(org) &&
    org.permissions.includes('credential:issue') &&
    credential.status === 'issued';

  return (
    <>
      <PageHeader
        icon={Inbox}
        title={credential.recipient.name}
        description={credential.achievement.name}
      />
      <OrgStatusBanner org={org} />
      <div className="mb-6">
        <Link
          to="/app/orgs/$orgId/credentials"
          params={{ orgId }}
          className="text-sm font-semibold text-link underline-offset-4 hover:underline"
        >
          ← All awarded badges
        </Link>
      </div>
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Delivery</CardTitle>
            <CardDescription>
              <StatusBadges credential={credential} />
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Timeline credential={credential} />
          </CardContent>
          {canSend && (
            <CardFooter>
              {resend.isError && (
                <Alert variant="error" className="w-full">
                  {errorMessage(resend.error)}
                </Alert>
              )}
              {resend.isSuccess && (
                <Alert variant="success" className="w-full">
                  A new link is on its way. The previous link no longer works.
                </Alert>
              )}
              <ConfirmButton
                variant="outline"
                confirmLabel="Send"
                question={`Email a new link to ${credential.recipient.email}? The old link stops working.`}
                pending={resend.isPending}
                onConfirm={() => resend.mutate()}
              >
                {credential.emails.length > 0 ? 'Send the link again' : 'Send the link'}
              </ConfirmButton>
            </CardFooter>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Badge</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-semibold">Recipient</dt>
                <dd className="break-all text-muted-foreground">
                  {credential.recipient.name} · {credential.recipient.email}
                </dd>
              </div>
              <div>
                <dt className="font-semibold">Achievement</dt>
                <dd className="text-muted-foreground">
                  {credential.achievement.name} (revision {credential.achievement.revision})
                </dd>
              </div>
              <div>
                <dt className="font-semibold">Awarded on</dt>
                <dd className="text-muted-foreground">{formatDate(credential.validFrom)}</dd>
              </div>
              <div>
                <dt className="font-semibold">Expires</dt>
                <dd className="text-muted-foreground">
                  {credential.validUntil ? formatDate(credential.validUntil) : 'Never'}
                </dd>
              </div>
              <div>
                <dt className="font-semibold">Page</dt>
                <dd className="text-muted-foreground">
                  {credential.visibility === 'hidden' ? 'Hidden by the recipient' : 'Public'}
                </dd>
              </div>
              {credential.claimLinkExpiresAt && (
                <div>
                  <dt className="font-semibold">Recipient’s link works until</dt>
                  <dd className="text-muted-foreground">
                    {formatDate(credential.claimLinkExpiresAt)}
                  </dd>
                </div>
              )}
              <div className="sm:col-span-2">
                <dt className="font-semibold">Credential ID</dt>
                <dd className="font-mono text-xs break-all text-muted-foreground">
                  {credential.url}
                </dd>
              </div>
            </dl>
          </CardContent>
          {credential.visibility === 'public' && (
            <CardFooter>
              <Button asChild variant="outline">
                <a href={credential.url} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden="true" />
                  Open the badge page
                </a>
              </Button>
            </CardFooter>
          )}
        </Card>
      </div>
    </>
  );
}
