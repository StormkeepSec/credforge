import type { CredentialState, MeResponse, RecipientCredential } from '@credforge/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Award, Building2, Download, ExternalLink, Eye, EyeOff, Medal } from 'lucide-react';
import { useId } from 'react';
import { PageHeader } from '../components/app-shell';
import { InvitationsCard } from '../components/invitations-card';
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
import { errorMessage, fetchMyCredentials, patch, queries } from '../lib/api';
import { formatDay } from '../lib/utils';

const STATE: Record<CredentialState, { label: string; variant: 'success' | 'warning' | 'danger' }> =
  {
    valid: { label: 'Valid', variant: 'success' },
    not_yet_valid: { label: 'Not valid yet', variant: 'warning' },
    expired: { label: 'Expired', variant: 'warning' },
    revoked: { label: 'Revoked', variant: 'danger' },
  };

function StateBadge({ credential }: { credential: RecipientCredential }) {
  if (credential.revocation?.kind === 'superseded') {
    return <Badge variant="danger">Replaced</Badge>;
  }
  const { label, variant } = STATE[credential.state];
  return <Badge variant={variant}>{label}</Badge>;
}

/** "a@example.org", "a@example.org and b@example.org", "a, b and c". */
function listAddresses(addresses: string[]): string {
  if (addresses.length <= 1) return addresses[0] ?? '';
  return `${addresses.slice(0, -1).join(', ')} and ${addresses.at(-1)}`;
}

/** What happened to the badge, in a sentence: revoked, replaced, expired, or when it expires. */
function StatusLine({ credential: c }: { credential: RecipientCredential }) {
  if (c.revocation) {
    return (
      <p className="mt-2 text-sm">
        {c.revocation.kind === 'superseded'
          ? `${c.issuer.name} replaced it with a corrected copy on ${formatDay(c.revocation.at)}.`
          : `${c.issuer.name} revoked it on ${formatDay(c.revocation.at)}.`}
        {c.revocation.publicReason && (
          <span className="text-muted-foreground"> Reason: {c.revocation.publicReason}</span>
        )}
      </p>
    );
  }
  if (c.state === 'expired' && c.validUntil) {
    return <p className="mt-2 text-sm">Expired on {formatDay(c.validUntil)}.</p>;
  }
  if (c.state === 'not_yet_valid') {
    return <p className="mt-2 text-sm">Valid from {formatDay(c.validFrom)}.</p>;
  }
  if (c.validUntil) {
    return <p className="mt-2 text-sm text-muted-foreground">Expires {formatDay(c.validUntil)}.</p>;
  }
  return null;
}

function BadgeCard({
  credential: c,
  showAddress,
}: {
  credential: RecipientCredential;
  showAddress: boolean;
}) {
  const queryClient = useQueryClient();
  const headingId = useId();
  const hidden = c.visibility === 'hidden';
  const visibility = useMutation({
    mutationFn: (wanted: 'public' | 'hidden') =>
      patch<RecipientCredential>(`/me/credentials/${c.id}`, { visibility: wanted }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me', 'credentials'] }),
  });

  return (
    <article
      aria-labelledby={headingId}
      className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-[6rem_1fr] sm:p-5"
    >
      <div className="flex size-24 items-center justify-center overflow-hidden rounded-lg bg-muted">
        {c.achievement.image ? (
          <img
            src={c.achievement.image}
            alt=""
            width={96}
            height={96}
            className="size-full object-contain"
          />
        ) : (
          <Award className="size-8 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0">
        <h2 id={headingId} className="text-lg font-semibold break-words">
          <a href={c.url} className="underline-offset-4 hover:underline">
            {c.achievement.name}
          </a>
        </h2>
        <p className="text-sm text-muted-foreground">
          Awarded by {c.issuer.name} on {formatDay(c.validFrom)}
          {showAddress && ` to ${c.recipient.email}`}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <StateBadge credential={c} />
          {hidden && <Badge>Page hidden</Badge>}
        </div>
        <StatusLine credential={c} />
        {hidden && (
          <p className="mt-2 text-sm text-muted-foreground">
            Only you can see its page, signed in. Everyone else gets “page not found”.
          </p>
        )}
        {visibility.isError && (
          <Alert variant="error" className="mt-3">
            {errorMessage(visibility.error)}
          </Alert>
        )}
        <ul aria-label={`${c.achievement.name}: actions`} className="mt-4 flex flex-wrap gap-2">
          <li>
            <Button asChild size="sm" variant="outline">
              <a href={c.url}>
                <ExternalLink aria-hidden="true" />
                Open its page
              </a>
            </Button>
          </li>
          <li>
            <Button asChild size="sm" variant="outline">
              <a href={c.downloads.png} download>
                <Download aria-hidden="true" />
                Badge (PNG)
              </a>
            </Button>
          </li>
          {c.downloads.svg && (
            <li>
              <Button asChild size="sm" variant="outline">
                <a href={c.downloads.svg} download>
                  <Download aria-hidden="true" />
                  Badge (SVG)
                </a>
              </Button>
            </li>
          )}
          <li>
            <Button asChild size="sm" variant="outline">
              <a href={c.downloads.json} download>
                <Download aria-hidden="true" />
                Credential (JSON)
              </a>
            </Button>
          </li>
          <li>
            <Button asChild size="sm" variant="outline">
              <a href={c.linkedInUrl} rel="noopener noreferrer" target="_blank">
                Add to LinkedIn
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          </li>
          <li>
            <Button
              size="sm"
              variant="outline"
              pending={visibility.isPending}
              onClick={() => visibility.mutate(hidden ? 'public' : 'hidden')}
            >
              {hidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
              {hidden ? 'Make its page public' : 'Hide its page'}
            </Button>
          </li>
        </ul>
      </div>
    </article>
  );
}

/** Where to go to award badges: one clear step away for people who only receive them. */
function CreateOrgCard({ me }: { me: MeResponse }) {
  const { data: instance } = useQuery(queries.instance());
  const onlyAdminsCreate = instance?.signupMode === 'invite' && !me.user.isPlatformAdmin;
  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="size-5 text-link" aria-hidden="true" />
          Award badges yourself
        </CardTitle>
        <CardDescription>
          {onlyAdminsCreate
            ? 'On this credforge site, a platform admin creates organizations. Ask yours to invite you.'
            : 'Create an organization for your team: its issuer profile, achievements and awards. You don’t need one to keep your own badges.'}
        </CardDescription>
      </CardHeader>
      {!onlyAdminsCreate && (
        <CardFooter>
          <Button asChild variant="outline">
            <Link to="/app/orgs/new">Create an organization</Link>
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

/**
 * My badges (design plan §8.8): every badge awarded to the person's confirmed addresses, by any
 * organization, with what they can do with each one. People who only receive badges start here.
 */
export function MyBadgesPage({ me }: { me: MeResponse }) {
  const pages = useInfiniteQuery({
    queryKey: ['me', 'credentials'],
    queryFn: ({ pageParam }) => fetchMyCredentials(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const credentials = pages.data?.pages.flatMap((page) => page.credentials) ?? [];
  const addresses = pages.data?.pages[0]?.addresses ?? [me.user.email];

  return (
    <>
      <PageHeader
        icon={Medal}
        title="My badges"
        description={`Badges awarded to ${listAddresses(addresses)}, by any organization.`}
      />
      <InvitationsCard me={me} className="mb-6" />
      {pages.isPending ? (
        <Spinner />
      ) : pages.error ? (
        <Alert variant="error">{errorMessage(pages.error)}</Alert>
      ) : credentials.length === 0 ? (
        <Card>
          <CardContent>
            <p className="font-semibold">No badges yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              When an organization awards a badge to {listAddresses(addresses)}, it shows up here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-4" aria-label="My badges">
          {credentials.map((credential) => (
            <li key={credential.id}>
              <BadgeCard credential={credential} showAddress={addresses.length > 1} />
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
      <p className="mt-8 text-sm text-muted-foreground">
        Badges sent to another address?{' '}
        <Link to="/app/settings" hash="email-addresses" className="text-link underline">
          Add it in Account settings
        </Link>
        : once you confirm it, its badges show here too.
      </p>
      {me.memberships.length === 0 && <CreateOrgCard me={me} />}
    </>
  );
}
