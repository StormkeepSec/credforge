import type { OrgStatus, PlatformOrg } from '@credforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '../components/app-shell';
import { ConfirmButton } from '../components/confirm';
import { ModerationItemCard, OrgActions, ReasonButton } from '../components/moderation';
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
import { Alert, Badge, Spinner } from '../components/ui/feedback';
import { Field, Input, Textarea } from '../components/ui/input';
import { ApiError, errorMessage, patch, post, queries } from '../lib/api';
import { cn, formatDate } from '../lib/utils';

const TABS: { status: OrgStatus | 'all'; label: string }[] = [
  { status: 'pending', label: 'Waiting' },
  { status: 'active', label: 'Approved' },
  { status: 'suspended', label: 'Suspended' },
  { status: 'declined', label: 'Declined' },
  { status: 'all', label: 'All' },
];

type Decision = 'approve' | 'decline' | 'suspend' | 'reinstate';

function OrgCard({ org, onDone }: { org: PlatformOrg; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [reasonFor, setReasonFor] = useState<'decline' | 'suspend' | null>(null);
  const [reason, setReason] = useState('');
  // Approving reviews the org's first content too (design plan §6.5): what is shown here is
  // cleared with the approval.
  const review = useQuery({
    ...queries.moderationItems('pending', org.id),
    enabled: org.status === 'pending' || org.status === 'declined',
  });
  // Only while it waits: after approving, the list fetched before stays in the cache.
  const toClear =
    org.status === 'pending' || org.status === 'declined' ? (review.data?.items ?? []) : [];
  const decide = useMutation({
    mutationFn: (decision: Decision) =>
      post(`/platform/orgs/${org.id}/${decision}`, {
        ...(reasonFor && { reason }),
        ...(decision === 'approve' && { clearItemIds: toClear.map((item) => item.id) }),
      }),
    onSuccess: async () => {
      setReasonFor(null);
      setReason('');
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
  });
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown; done: string }) =>
      post(path, body ?? {}),
    onSuccess: async (_result, { done }) => {
      onDone(done);
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
  });
  const run = (path: string, done: string, body?: unknown) => act.mutate({ path, body, done });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {org.name}
          <OrgStatusBadge status={org.status} />
          {org.trustedAt && <Badge variant="success">Trusted</Badge>}
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
                    {issuer.domainVerified ? (
                      <Badge variant="success">Domain verified</Badge>
                    ) : (
                      <span className="text-muted-foreground">
                        (self-reported, domain not verified)
                      </span>
                    )}
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
        <p className="text-muted-foreground">
          {org.review.pending === 0 && org.review.openReports === 0 ? (
            'Nothing waiting for review, no open reports.'
          ) : (
            <Link to="/app/platform/moderation" className="text-link underline">
              {org.review.pending} waiting for review · {org.review.openReports}{' '}
              {org.review.openReports === 1 ? 'open report' : 'open reports'}
            </Link>
          )}
          {' · '}
          {org.activeCredentials} {org.activeCredentials === 1 ? 'badge' : 'badges'} awarded
          {org.trustedAt
            ? ` · trusted since ${formatDate(org.trustedAt)}: new content is published without review`
            : ''}
        </p>
        {toClear.length > 0 && (
          <section aria-label={`${org.name}: content to review`} className="grid gap-3">
            <h3 className="font-semibold">Content to review before approving</h3>
            {toClear.map((item) => (
              <ModerationItemCard key={item.id} item={item} onDone={onDone} orgActions={false} />
            ))}
          </section>
        )}
        <Limits org={org} />
        {act.isError && <Alert variant="error">{errorMessage(act.error)}</Alert>}
        {decide.isError && <Alert variant="error">{errorMessage(decide.error)}</Alert>}
        {reasonFor && (
          <Field label={`Reason (shown to the organization’s owners)`}>
            {(props) => (
              <Textarea
                {...props}
                autoFocus
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
                {toClear.length > 0
                  ? `Approve and publish ${toClear.length} ${toClear.length === 1 ? 'item' : 'items'}`
                  : 'Approve'}
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
            {org.status === 'suspended' && org.activeCredentials > 0 && (
              <OrgActions
                org={{
                  id: org.id,
                  name: org.name,
                  status: org.status,
                  trusted: Boolean(org.trustedAt),
                }}
                run={run}
                pending={act.isPending}
              />
            )}
            {org.trustedAt ? (
              <ConfirmButton
                variant="outline"
                question="New content will wait for review again."
                confirmLabel="Remove trust"
                pending={act.isPending}
                onConfirm={() =>
                  run(`/platform/orgs/${org.id}/trust`, `${org.name} is no longer trusted.`, {
                    trusted: false,
                  })
                }
              >
                Remove trust
              </ConfirmButton>
            ) : (
              <Button
                variant="outline"
                pending={act.isPending}
                onClick={() =>
                  run(`/platform/orgs/${org.id}/trust`, `${org.name} is trusted.`, {
                    trusted: true,
                  })
                }
              >
                Mark as trusted
              </Button>
            )}
            {org.requestedBy && !org.requestedBy.disabled && (
              <ReasonButton
                size="default"
                label={`Disable ${org.requestedBy.name || org.requestedBy.email}’s account`}
                confirmLabel="Disable account"
                reasonLabel="Reason (emailed to them and the organization’s owners)"
                pending={act.isPending}
                onConfirm={(text) =>
                  run(`/platform/users/${org.requestedBy?.id}/disable`, 'Account disabled.', {
                    reason: text,
                    orgId: org.id,
                  })
                }
              />
            )}
          </>
        )}
      </CardFooter>
    </Card>
  );
}

type LimitField = 'dailySendLimit' | 'uploadRateLimit' | 'storageQuotaMb';

const asText = (value: number | null) => (value === null ? '' : String(value));
const fallbackText = (value: number, unit: string) =>
  value === 0 ? 'no limit' : `${value.toLocaleString()} ${unit}`;

/**
 * An org's own limits, or the instance defaults: its daily award-email cap (design plan §6.3),
 * uploads per hour and storage quota (§6.5).
 */
function Limits({ org }: { org: PlatformOrg }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<LimitField, string>>({
    dailySendLimit: asText(org.dailySendLimit),
    uploadRateLimit: asText(org.uploadRateLimit),
    storageQuotaMb: asText(org.storageQuotaMb),
  });
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      patch(
        `/platform/orgs/${org.id}/limits`,
        Object.fromEntries(
          Object.entries(values).map(([field, value]) => [
            field,
            value.trim() === '' ? null : Number(value),
          ]),
        ),
      ),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
  });
  const errors = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const fields: { field: LimitField; label: string; description: string }[] = [
    {
      field: 'dailySendLimit',
      label: 'Award emails per day',
      description: `Empty: the instance default (${fallbackText(org.defaultDailySendLimit, 'a day')}). 0: no limit.`,
    },
    {
      field: 'uploadRateLimit',
      label: 'Uploads per hour',
      description: `Images and CSV files. Empty: the default (${fallbackText(org.defaultUploadRateLimit, 'an hour')}).`,
    },
    {
      field: 'storageQuotaMb',
      label: 'Storage (MB)',
      description: `${(org.storageUsedBytes / (1024 * 1024)).toFixed(1)} MB used. Empty: the default (${fallbackText(org.defaultStorageQuotaMb, 'MB')}).`,
    },
  ];
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {fields.map(({ field, label, description }) => (
          <Field key={field} label={label} description={description} error={errors[field]}>
            {(props) => (
              <Input
                {...props}
                type="number"
                inputMode="numeric"
                min={0}
                value={values[field]}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({ ...current, [field]: event.target.value }));
                }}
              />
            )}
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" pending={save.isPending}>
          Save limits
        </Button>
        <span role="status" className="text-sm text-muted-foreground">
          {saved
            ? 'Saved.'
            : save.isError && Object.keys(errors).length === 0
              ? errorMessage(save.error)
              : ''}
        </span>
      </div>
    </form>
  );
}

/** Platform admins: the approval queue and every organization on the instance (design plan §6.3). */
export function PlatformPage() {
  const [tab, setTab] = useState<OrgStatus | 'all'>('pending');
  const [message, setMessage] = useState('');
  const { data, isPending, isError, error } = useQuery(queries.platformOrgs(tab));

  return (
    <>
      <PageHeader
        icon={ShieldCheck}
        title="Platform"
        description="Approve new organizations before they can award badges to people outside their team, and review their first content as you do."
      />
      {/* A filter, so toggle buttons rather than tabs (which promise arrow-key navigation). */}
      <fieldset className="mb-6 min-w-0">
        <legend className="sr-only">Show organizations</legend>
        <div className="flex flex-wrap gap-2">
          {TABS.map((item) => (
            <button
              key={item.status}
              type="button"
              aria-pressed={tab === item.status}
              onClick={() => setTab(item.status)}
              className={cn(
                'rounded-full border px-4 py-1.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                tab === item.status
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'bg-card hover:bg-muted',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </fieldset>
      <p role="status" className="mb-4 text-sm font-semibold">
        {message}
      </p>
      <div className="grid gap-4">
        {isPending && <Spinner />}
        {isError && <Alert variant="error">{errorMessage(error)}</Alert>}
        {data?.orgs.length === 0 && (
          <p className="text-muted-foreground">
            {tab === 'pending' ? 'Nothing waiting for approval.' : 'No organizations here.'}
          </p>
        )}
        {data?.orgs.map((org) => (
          <OrgCard key={org.id} org={org} onDone={setMessage} />
        ))}
      </div>
    </>
  );
}
