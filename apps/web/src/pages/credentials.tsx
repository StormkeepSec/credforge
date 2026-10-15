import {
  type BulkRevokeResult,
  type CredentialDetails,
  type CredentialFilters,
  type CredentialState,
  type CredentialSummary,
  type ReissueInput,
  reissueInput,
  revokeInput,
} from '@credforge/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Award,
  CheckCircle2,
  Circle,
  Download,
  ExternalLink,
  Inbox,
  Search,
  XCircle,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
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
import { Field, Input, Select, Textarea } from '../components/ui/input';
import {
  ApiError,
  errorMessage,
  fetchCredentialPage,
  filterQuery,
  post,
  queries,
} from '../lib/api';
import { formatDate, formatDateTime, formatDay } from '../lib/utils';

const STATE: Record<CredentialState, { label: string; variant: 'success' | 'warning' | 'danger' }> =
  {
    valid: { label: 'Valid', variant: 'success' },
    not_yet_valid: { label: 'Not valid yet', variant: 'warning' },
    expired: { label: 'Expired', variant: 'warning' },
    revoked: { label: 'Revoked', variant: 'danger' },
  };

function StateBadge({ credential }: { credential: CredentialSummary }) {
  if (credential.revocation?.kind === 'superseded') return <Badge>Replaced</Badge>;
  const { label, variant } = STATE[credential.state];
  return <Badge variant={variant}>{label}</Badge>;
}

function StatusBadges({ credential }: { credential: CredentialSummary }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      <StateBadge credential={credential} />
      <DeliveryBadge status={credential.delivery} />
      {credential.acceptedAt && <Badge variant="success">Opened</Badge>}
      {credential.visibility === 'hidden' && <Badge>Hidden by recipient</Badge>}
    </span>
  );
}

const STATE_OPTIONS: [CredentialState | '', string][] = [
  ['', 'Any status'],
  ['valid', 'Valid'],
  ['not_yet_valid', 'Not valid yet'],
  ['expired', 'Expired'],
  ['revoked', 'Revoked or replaced'],
];

function cleanFilters(filters: CredentialFilters): CredentialFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => typeof value === 'string' && value.trim() !== ''),
  ) as CredentialFilters;
}

/**
 * What was awarded, newest first (design plan §11.1): search by name or email, filter by
 * achievement, status, upload and date, revoke several at once, and export what matches.
 */
export function CredentialsPage({
  orgId,
  filters: given,
}: {
  orgId: string;
  filters: CredentialFilters;
}) {
  const filters = cleanFilters(given);
  const filtering = Object.keys(filters).length > 0;
  const queryClient = useQueryClient();
  const { data: org } = useQuery(queries.org(orgId));
  const pages = useInfiniteQuery({
    queryKey: ['org', orgId, 'credentials', filters],
    queryFn: ({ pageParam }) => fetchCredentialPage(orgId, filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [revoked, setRevoked] = useState<BulkRevokeResult | null>(null);
  if (!org || pages.isPending) return <Spinner />;
  const credentials = pages.data?.pages.flatMap((page) => page.credentials) ?? [];
  const canAward = isWritable(org) && org.permissions.includes('credential:issue');
  const canRevoke = isWritable(org) && org.permissions.includes('credential:revoke');
  const canExport = org.permissions.includes('credential:export');
  const query = filterQuery(filters);

  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <>
      <PageHeader
        icon={Inbox}
        title="Awarded badges"
        description="Everything your organization has awarded, whether the email arrived, and whether it still counts."
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
      <FilterForm orgId={orgId} filters={filters} />
      {canExport && (
        <section
          aria-labelledby="export-heading"
          className="mb-6 flex flex-wrap items-center gap-3"
        >
          <h2 id="export-heading" className="text-sm font-semibold">
            Export {filtering ? 'these results' : 'everything'}
          </h2>
          <Button asChild variant="outline" size="sm">
            <a href={`/api/v1/orgs/${orgId}/exports/credentials.csv${query}`} download>
              <Download aria-hidden="true" />
              CSV
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={`/api/v1/orgs/${orgId}/exports/credentials.jsonl${query}`} download>
              <Download aria-hidden="true" />
              JSON Lines (with the signed credentials)
            </a>
          </Button>
        </section>
      )}
      {pages.error && <Alert variant="error">{errorMessage(pages.error)}</Alert>}
      {revoked && (
        <Alert variant="success" className="mb-6" title={`Revoked ${revoked.revoked.length}`}>
          {revoked.alreadyRevoked.length > 0 &&
            `${revoked.alreadyRevoked.length} were already revoked. `}
          Their status lists are updated within a minute.
        </Alert>
      )}
      {canRevoke && selected.size > 0 && (
        <BulkRevoke
          orgId={orgId}
          ids={[...selected]}
          onDone={async (result) => {
            setRevoked(result);
            setSelected(new Set());
            await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'credentials'] });
          }}
          onCancel={() => setSelected(new Set())}
        />
      )}
      {credentials.length === 0 ? (
        <Card>
          <CardContent>
            <p className="font-semibold">{filtering ? 'Nothing matches' : 'Nothing awarded yet'}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {filtering
                ? 'Try a shorter search or fewer filters.'
                : 'Badges you award show up here with their delivery status.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-3" aria-label="Awarded badges">
          {credentials.map((credential) => (
            <li key={credential.id} className="flex items-stretch gap-3">
              {canRevoke && (
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    aria-label={`Select ${credential.recipient.name}, ${credential.achievement.name}`}
                    disabled={credential.status !== 'issued'}
                    checked={selected.has(credential.id)}
                    onChange={(event) => toggle(credential.id, event.target.checked)}
                    className="size-4 accent-[var(--color-link)]"
                  />
                </div>
              )}
              <Link
                to="/app/orgs/$orgId/credentials/$credentialId"
                params={{ orgId, credentialId: credential.id }}
                className="grid min-w-0 flex-1 gap-3 rounded-xl border bg-card p-4 hover:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:grid-cols-[3rem_1fr_auto] sm:items-center"
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

function FilterForm({ orgId, filters }: { orgId: string; filters: CredentialFilters }) {
  const navigate = useNavigate();
  const achievements = useQuery(queries.achievements(orgId));
  const batches = useQuery(queries.batches(orgId));
  const [form, setForm] = useState({
    q: filters.q ?? '',
    achievementId: filters.achievementId ?? '',
    status: filters.status ?? '',
    batchId: filters.batchId ?? '',
    from: filters.from ?? '',
    to: filters.to ?? '',
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  function apply(next: typeof form) {
    void navigate({
      to: '/app/orgs/$orgId/credentials',
      params: { orgId },
      search: cleanFilters(next as CredentialFilters),
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    apply(form);
  }

  const batchOptions = batches.data?.batches.filter((batch) => batch.status !== 'draft') ?? [];
  return (
    <search aria-label="Search awarded badges" className="mb-6 block">
      <form
        onSubmit={onSubmit}
        className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <Field label="Name or email" className="sm:col-span-2 lg:col-span-1">
          {(props) => (
            <Input {...props} type="search" value={form.q} onChange={set('q')} autoComplete="off" />
          )}
        </Field>
        <Field label="Achievement">
          {(props) => (
            <Select {...props} value={form.achievementId} onChange={set('achievementId')}>
              <option value="">Any achievement</option>
              {achievements.data?.achievements
                .filter((achievement) => achievement.status !== 'draft')
                .map((achievement) => (
                  <option key={achievement.id} value={achievement.id}>
                    {achievement.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Status">
          {(props) => (
            <Select {...props} value={form.status} onChange={set('status')}>
              {STATE_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="From a CSV upload">
          {(props) => (
            <Select {...props} value={form.batchId} onChange={set('batchId')}>
              <option value="">Any (or none)</option>
              {form.batchId && !batchOptions.some((batch) => batch.id === form.batchId) && (
                <option value={form.batchId}>The chosen upload</option>
              )}
              {batchOptions.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.fileName ?? 'API rows'} ({formatDate(batch.createdAt)})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Awarded from">
          {(props) => <Input {...props} type="date" value={form.from} onChange={set('from')} />}
        </Field>
        <Field label="Awarded until">
          {(props) => <Input {...props} type="date" value={form.to} onChange={set('to')} />}
        </Field>
        <div className="flex flex-wrap gap-3 sm:col-span-2 lg:col-span-3">
          <Button type="submit">
            <Search aria-hidden="true" />
            Search
          </Button>
          {Object.values(form).some(Boolean) && (
            <Button
              variant="ghost"
              onClick={() => {
                const empty = {
                  q: '',
                  achievementId: '',
                  status: '',
                  batchId: '',
                  from: '',
                  to: '',
                };
                setForm(empty);
                apply(empty);
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </form>
    </search>
  );
}

function BulkRevoke({
  orgId,
  ids,
  onDone,
  onCancel,
}: {
  orgId: string;
  ids: string[];
  onDone: (result: BulkRevokeResult) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [publicReason, setPublicReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const revoke = useMutation({
    mutationFn: () =>
      post<BulkRevokeResult>(`/orgs/${orgId}/credentials/revoke`, {
        credentialIds: ids,
        reason,
        publicReason,
      }),
    onSuccess: onDone,
  });

  function check(): boolean {
    const parsed = revokeInput.safeParse({ reason, publicReason });
    if (parsed.success) {
      setErrors({});
      return true;
    }
    const next: Record<string, string> = {};
    for (const issue of parsed.error.issues) next[issue.path.join('.')] ??= issue.message;
    setErrors(next);
    return false;
  }

  return (
    <section
      aria-labelledby="bulk-heading"
      className="mb-6 grid gap-4 rounded-xl border border-destructive/40 bg-card p-4"
    >
      <h2 id="bulk-heading" className="font-semibold">
        Revoke {ids.length} selected {ids.length === 1 ? 'badge' : 'badges'}
      </h2>
      {revoke.isError && <Alert variant="error">{errorMessage(revoke.error)}</Alert>}
      <RevokeFields
        reason={reason}
        publicReason={publicReason}
        errors={errors}
        onReason={setReason}
        onPublicReason={setPublicReason}
      />
      <div className="flex flex-wrap gap-3">
        <ConfirmButton
          variant="destructive"
          confirmLabel="Revoke"
          question={`Revoke ${ids.length} ${ids.length === 1 ? 'badge' : 'badges'}? This can’t be undone.`}
          pending={revoke.isPending}
          onConfirm={() => {
            if (check()) revoke.mutate();
          }}
        >
          Revoke {ids.length}
        </ConfirmButton>
        <Button variant="ghost" onClick={onCancel}>
          Clear the selection
        </Button>
      </div>
    </section>
  );
}

function RevokeFields({
  reason,
  publicReason,
  errors,
  onReason,
  onPublicReason,
}: {
  reason: string;
  publicReason: string;
  errors: Record<string, string>;
  onReason: (value: string) => void;
  onPublicReason: (value: string) => void;
}) {
  return (
    <>
      <Field
        label="Reason (for your organization)"
        description="Kept in the audit log. Never shown publicly."
        error={errors.reason}
      >
        {(props) => (
          <Textarea
            {...props}
            className="min-h-16"
            value={reason}
            onChange={(event) => onReason(event.target.value)}
          />
        )}
      </Field>
      <Field
        label="Public reason (optional)"
        description="Shown on the badge’s page, after “Revoked on …”."
        error={errors.publicReason}
      >
        {(props) => (
          <Input
            {...props}
            value={publicReason}
            onChange={(event) => onPublicReason(event.target.value)}
          />
        )}
      </Field>
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

/** The issued → emailed → delivered → opened → revoked timeline (design plan §11.1). */
function Timeline({ credential }: { credential: CredentialDetails }) {
  const email = credential.emails[0];
  const problem =
    email && ['bounced', 'dropped', 'failed', 'spam_reported'].includes(email.status)
      ? email
      : null;
  const revocation = credential.revocation;
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
      {revocation && (
        <TimelineStep
          state="failed"
          title={revocation.kind === 'superseded' ? 'Replaced by a corrected copy' : 'Revoked'}
        >
          {formatDateTime(revocation.at)}
          {credential.revokedBy?.label && ` by ${credential.revokedBy.label}`}
        </TimelineStep>
      )}
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
  const writable = isWritable(org) && credential.status === 'issued';
  const canSend = writable && org.permissions.includes('credential:issue');
  const canRevoke = writable && org.permissions.includes('credential:revoke');
  const revocation = credential.revocation;

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
        {credential.replacesId && (
          <Alert variant="info" live={false} title="A corrected copy">
            This badge replaces an{' '}
            <Link
              to="/app/orgs/$orgId/credentials/$credentialId"
              params={{ orgId, credentialId: credential.replacesId }}
            >
              earlier copy
            </Link>
            , which now shows as replaced.
          </Alert>
        )}
        {revocation && (
          <Alert
            variant="warning"
            live={false}
            title={
              revocation.kind === 'superseded'
                ? `Replaced on ${formatDate(revocation.at)}`
                : `Revoked on ${formatDate(revocation.at)}`
            }
          >
            {credential.replacedById && (
              <>
                See the{' '}
                <Link
                  to="/app/orgs/$orgId/credentials/$credentialId"
                  params={{ orgId, credentialId: credential.replacedById }}
                >
                  corrected copy
                </Link>
                .{' '}
              </>
            )}
            {revocation.reason && <>Reason: {revocation.reason}. </>}
            {revocation.publicReason && <>Shown publicly: “{revocation.publicReason}”.</>}
          </Alert>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
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
                <dd className="text-muted-foreground">{formatDay(credential.validFrom)}</dd>
              </div>
              <div>
                <dt className="font-semibold">Expires</dt>
                <dd className="text-muted-foreground">
                  {credential.validUntil ? formatDay(credential.validUntil) : 'Never'}
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
              {credential.batchId && (
                <div>
                  <dt className="font-semibold">Awarded from</dt>
                  <dd>
                    <Link
                      to="/app/orgs/$orgId/award/many/$batchId"
                      params={{ orgId, batchId: credential.batchId }}
                      className="text-link underline-offset-4 hover:underline"
                    >
                      A CSV upload
                    </Link>
                  </dd>
                </div>
              )}
              {credential.evidence.length > 0 && (
                <div className="sm:col-span-2">
                  <dt className="font-semibold">Evidence</dt>
                  {credential.evidence.map((item, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: evidence has no id of its own
                    <dd key={index} className="break-all text-muted-foreground">
                      {item.url ?? item.name ?? item.narrative}
                    </dd>
                  ))}
                </div>
              )}
              {Object.entries(credential.customFields).map(([key, value]) => (
                <div key={key}>
                  <dt className="font-semibold">{key}</dt>
                  <dd className="break-words text-muted-foreground">{value}</dd>
                </div>
              ))}
              <div className="sm:col-span-2">
                <dt className="font-semibold">Credential ID</dt>
                <dd className="font-mono text-xs break-all text-muted-foreground">
                  {credential.url}
                </dd>
              </div>
            </dl>
            {Object.keys(credential.customFields).length > 0 && (
              <p className="mt-4 text-sm text-muted-foreground">
                Fields from the CSV file are kept for your records only: they aren’t in the signed
                badge or on its page.
              </p>
            )}
          </CardContent>
          {credential.visibility === 'public' && (
            <CardFooter>
              <Button asChild variant="outline">
                <a href={credential.url} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden="true" />
                  Open the badge page
                </a>
              </Button>
              <Button asChild variant="outline">
                <a
                  href={`/verify?url=${encodeURIComponent(credential.url)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink aria-hidden="true" />
                  Check it in the verification tool
                </a>
              </Button>
            </CardFooter>
          )}
        </Card>

        {canRevoke && org.permissions.includes('credential:issue') && (
          <ReissueCard orgId={orgId} credential={credential} />
        )}
        {canRevoke && <RevokeCard orgId={orgId} credential={credential} />}
      </div>
    </>
  );
}

function RevokeCard({ orgId, credential }: { orgId: string; credential: CredentialDetails }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [publicReason, setPublicReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const revoke = useMutation({
    mutationFn: () =>
      post<CredentialDetails>(`/orgs/${orgId}/credentials/${credential.id}/revoke`, {
        reason,
        publicReason,
      }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(queries.credential(orgId, credential.id).queryKey, updated);
      await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'credentials'] });
    },
    onError: (error) => {
      if (error instanceof ApiError) setErrors(error.fieldErrors);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revoke</CardTitle>
        <CardDescription>
          The badge stops counting: its page shows “Revoked”, and its signed status list says so
          within a minute. This can’t be undone. To fix a mistake instead, reissue it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {revoke.isError && Object.keys(errors).length === 0 && (
          <Alert variant="error">{errorMessage(revoke.error)}</Alert>
        )}
        <RevokeFields
          reason={reason}
          publicReason={publicReason}
          errors={errors}
          onReason={setReason}
          onPublicReason={setPublicReason}
        />
      </CardContent>
      <CardFooter>
        <ConfirmButton
          variant="destructive"
          confirmLabel="Revoke"
          question={`Revoke ${credential.recipient.name}’s badge?`}
          pending={revoke.isPending}
          onConfirm={() => {
            const parsed = revokeInput.safeParse({ reason, publicReason });
            if (!parsed.success) {
              const next: Record<string, string> = {};
              for (const issue of parsed.error.issues) next[issue.path.join('.')] ??= issue.message;
              setErrors(next);
              return;
            }
            setErrors({});
            revoke.mutate();
          }}
        >
          Revoke badge
        </ConfirmButton>
      </CardFooter>
    </Card>
  );
}

/** A YYYY-MM-DD date (UTC) from an ISO date-time. */
const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

function ReissueCard({ orgId, credential }: { orgId: string; credential: CredentialDetails }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  const start = {
    name: credential.recipient.name,
    email: credential.recipient.email,
    issuedOn: dayOf(credential.validFrom),
    expiresOn: dayOf(credential.validUntil),
  };
  const [form, setForm] = useState({ ...start, reason: '', sendEmail: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Opening moves focus to the form's heading; cancelling hands it back to the button.
  useEffect(() => {
    if (open) heading.current?.focus();
    else if (closing.current) {
      closing.current = false;
      trigger.current?.focus();
    }
  }, [open]);

  const reissue = useMutation({
    mutationFn: (body: ReissueInput) =>
      post<CredentialDetails>(`/orgs/${orgId}/credentials/${credential.id}/reissue`, body),
    onSuccess: async (fresh) => {
      queryClient.setQueryData(queries.credential(orgId, fresh.id).queryKey, fresh);
      await queryClient.invalidateQueries({
        queryKey: ['org', orgId, 'credential', credential.id],
      });
      await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'credentials'] });
      await navigate({
        to: '/app/orgs/$orgId/credentials/$credentialId',
        params: { orgId, credentialId: fresh.id },
      });
    },
    onError: (error) => {
      if (error instanceof ApiError) setErrors(error.fieldErrors);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    // Only what changed is sent; everything else is copied from this badge.
    const body: ReissueInput = {
      recipient: {
        ...(form.name !== start.name && { name: form.name }),
        ...(form.email !== start.email && { email: form.email }),
      },
      ...(form.issuedOn !== start.issuedOn && { issuedOn: form.issuedOn }),
      ...(form.expiresOn !== start.expiresOn && { expiresOn: form.expiresOn || null }),
      ...(form.reason.trim() && { reason: form.reason }),
      sendEmail: form.sendEmail,
    };
    const parsed = reissueInput.safeParse(body);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[issue.path.join('.')] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    reissue.mutate(body);
  }

  const set =
    (key: 'name' | 'email' | 'issuedOn' | 'expiresOn' | 'reason') =>
    (event: { target: { value: string } }) =>
      setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <Card>
      <CardHeader>
        <CardTitle ref={heading} tabIndex={-1} className="outline-none">
          Reissue a corrected copy
        </CardTitle>
        <CardDescription>
          Signed badges can’t be edited. To fix a name, an address or a date, credforge signs a
          corrected copy, emails it, and marks this one as replaced. The achievement is signed as it
          is now.
        </CardDescription>
      </CardHeader>
      {!open ? (
        <CardFooter>
          <Button ref={trigger} variant="outline" onClick={() => setOpen(true)}>
            Correct and reissue
          </Button>
        </CardFooter>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <CardContent className="grid gap-5">
            {reissue.isError && Object.keys(errors).length === 0 && (
              <Alert variant="error" title="Not reissued">
                {errorMessage(reissue.error)}
              </Alert>
            )}
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Recipient’s name" error={errors['recipient.name']}>
                {(props) => <Input {...props} value={form.name} onChange={set('name')} />}
              </Field>
              <Field label="Recipient’s email address" error={errors['recipient.email']}>
                {(props) => (
                  <Input {...props} type="email" value={form.email} onChange={set('email')} />
                )}
              </Field>
              <Field label="Awarded on" error={errors.issuedOn}>
                {(props) => (
                  <Input {...props} type="date" value={form.issuedOn} onChange={set('issuedOn')} />
                )}
              </Field>
              <Field
                label="Expires on"
                description="Empty: it doesn’t expire."
                error={errors.expiresOn}
              >
                {(props) => (
                  <Input
                    {...props}
                    type="date"
                    value={form.expiresOn}
                    onChange={set('expiresOn')}
                  />
                )}
              </Field>
            </div>
            <Field
              label="Why (optional, for your organization)"
              description="Kept in the audit log."
              error={errors.reason}
            >
              {(props) => (
                <Textarea
                  {...props}
                  className="min-h-16"
                  value={form.reason}
                  onChange={set('reason')}
                />
              )}
            </Field>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={form.sendEmail}
                onChange={(event) =>
                  setForm((current) => ({ ...current, sendEmail: event.target.checked }))
                }
                className="mt-0.5 size-4 accent-[var(--color-link)]"
              />
              <span>
                <span className="font-semibold">Email the corrected badge</span>
                <span className="block text-muted-foreground">
                  To {form.email || 'the recipient'}, with a new link.
                </span>
              </span>
            </label>
          </CardContent>
          <CardFooter>
            <Button type="submit" pending={reissue.isPending}>
              Reissue
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                closing.current = true;
                setOpen(false);
              }}
            >
              Cancel
            </Button>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}
