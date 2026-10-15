import {
  BATCH_COLUMN_LABELS,
  BATCH_COLUMN_TARGETS,
  BATCH_LIMITS,
  type BatchColumnTarget,
  type BatchDetails,
  type BatchRowStatus,
  type BatchRowValidation,
  type BatchStatus,
  type BatchSummary,
  type UpdateBatchInput,
} from '@credforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../components/app-shell';
import { AwardTabs } from '../components/award-tabs';
import { ConfirmButton } from '../components/confirm';
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
import { Field, Select } from '../components/ui/input';
import { del, errorMessage, patch, post, queries, uploadCsv } from '../lib/api';
import { formatDateTime } from '../lib/utils';

const number = (value: number) => value.toLocaleString();
const plural = (count: number, one: string, many = `${one}s`) =>
  `${number(count)} ${count === 1 ? one : many}`;

const STATUS: Record<
  BatchStatus,
  { label: string; variant: 'neutral' | 'success' | 'warning' | 'danger' }
> = {
  draft: { label: 'Not confirmed', variant: 'warning' },
  queued: { label: 'Waiting to start', variant: 'neutral' },
  running: { label: 'Awarding', variant: 'neutral' },
  completed: { label: 'Done', variant: 'success' },
  failed: { label: 'Stopped', variant: 'danger' },
};

function BatchStatusBadge({ status }: { status: BatchStatus }) {
  const { label, variant } = STATUS[status];
  return <Badge variant={variant}>{label}</Badge>;
}

function batchName(batch: Pick<BatchSummary, 'fileName' | 'source'>) {
  return batch.fileName ?? (batch.source === 'api' ? 'Rows sent through the API' : 'Uploaded file');
}

function summaryLine(batch: BatchSummary): string {
  const { counts } = batch;
  if (batch.status === 'draft') {
    return `${plural(batch.totalRows, 'row')}: ${number(counts.ready)} ready, ${number(counts.invalid + counts.duplicate)} with problems`;
  }
  return [
    `${number(counts.issued)} awarded`,
    counts.pending > 0 && `${number(counts.pending)} waiting`,
    counts.failed > 0 && `${number(counts.failed)} failed`,
    counts.skipped > 0 && `${number(counts.skipped)} skipped`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Award many (design plan §8.3): upload a CSV file; earlier uploads below. */
export function AwardManyPage({ orgId }: { orgId: string }) {
  const { data: org } = useQuery(queries.org(orgId));
  const achievements = useQuery(queries.achievements(orgId, 'active'));
  const batches = useQuery(queries.batches(orgId));
  if (!org || achievements.isPending) return <Spinner />;
  const canAward = isWritable(org) && org.permissions.includes('credential:issue');
  const options = achievements.data?.achievements ?? [];

  return (
    <>
      <PageHeader
        icon={FileSpreadsheet}
        title="Award many"
        description="Upload a CSV file with a name and an email address for each person."
      />
      <OrgStatusBanner org={org} />
      <AwardTabs orgId={orgId} current="many" />
      {!canAward ? (
        <Alert variant="info">Your role can’t award badges in this organization.</Alert>
      ) : options.length === 0 ? (
        <Alert variant="info" title="Nothing to award yet">
          Publish an achievement first.{' '}
          <Link to="/app/orgs/$orgId/achievements" params={{ orgId }}>
            Go to achievements
          </Link>
        </Alert>
      ) : (
        <UploadCard orgId={orgId} achievements={options} pending={org.status === 'pending'} />
      )}

      <section aria-labelledby="batches-heading" className="mt-10">
        <h2 id="batches-heading" className="text-lg font-bold">
          Earlier uploads
        </h2>
        {batches.isPending ? (
          <Spinner />
        ) : batches.error ? (
          <Alert variant="error">{errorMessage(batches.error)}</Alert>
        ) : (batches.data?.batches.length ?? 0) === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nothing uploaded yet.</p>
        ) : (
          <ul className="mt-4 grid gap-3">
            {batches.data?.batches.map((batch) => (
              <li key={batch.id}>
                <Link
                  to="/app/orgs/$orgId/award/many/$batchId"
                  params={{ orgId, batchId: batch.id }}
                  className="grid gap-2 rounded-xl border bg-card p-4 hover:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:grid-cols-[1fr_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <p className="font-semibold break-words">{batchName(batch)}</p>
                    <p className="text-sm text-muted-foreground">
                      {batch.achievement.name} · {formatDateTime(batch.createdAt)}
                    </p>
                    <p className="mt-1 text-sm">{summaryLine(batch)}</p>
                  </div>
                  <BatchStatusBadge status={batch.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function UploadCard({
  orgId,
  achievements,
  pending,
}: {
  orgId: string;
  achievements: { id: string; name: string }[];
  pending: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [achievementId, setAchievementId] = useState(achievements[0]?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: (chosen: File) =>
      uploadCsv<BatchDetails>(
        `/orgs/${orgId}/batches?${new URLSearchParams({ achievementId, fileName: chosen.name })}`,
        chosen,
      ),
    onSuccess: async (batch) => {
      queryClient.setQueryData(queries.batch(orgId, batch.id).queryKey, batch);
      await queryClient.invalidateQueries({ queryKey: queries.batches(orgId).queryKey });
      await navigate({
        to: '/app/orgs/$orgId/award/many/$batchId',
        params: { orgId, batchId: batch.id },
      });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      setFileError('Choose a CSV file');
      return;
    }
    if (file.size > BATCH_LIMITS.maxBytes) {
      setFileError('The file is larger than 5 MB. Split it into smaller files.');
      return;
    }
    setFileError(null);
    upload.mutate(file);
  }

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate>
        <CardHeader>
          <CardTitle>Upload a CSV file</CardTitle>
          <CardDescription>
            Up to {number(BATCH_LIMITS.maxRows)} people and 5 MB. Each row needs a name (or a first
            and last name) and an email address; an award date and an expiry date (as YYYY-MM-DD)
            and an evidence link are optional. Other columns can be kept with each badge for your
            records. Nothing is awarded until you check the rows and confirm.
            {pending &&
              ' While your organization waits for approval, only its members can be awarded.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          {upload.isError && (
            <Alert variant="error" title="Can’t use this file">
              {errorMessage(upload.error)}
            </Alert>
          )}
          <Field label="Achievement">
            {(props) => (
              <Select
                {...props}
                value={achievementId}
                onChange={(event) => setAchievementId(event.target.value)}
              >
                {achievements.map((achievement) => (
                  <option key={achievement.id} value={achievement.id}>
                    {achievement.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="CSV file" error={fileError ?? undefined}>
            {(props) => (
              <input
                {...props}
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setFileError(null);
                }}
                className="block w-full rounded-md border border-input bg-card text-sm text-card-foreground file:mr-4 file:h-10 file:border-0 file:border-r file:border-input file:bg-muted file:px-4 file:font-semibold file:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              />
            )}
          </Field>
          <p className="text-sm">
            <a
              href={`/api/v1/orgs/${orgId}/batches/template.csv`}
              download
              className="inline-flex items-center gap-1.5 font-semibold text-link underline-offset-4 hover:underline"
            >
              <Download className="size-4" aria-hidden="true" />
              Download the template
            </a>
          </p>
        </CardContent>
        <CardFooter>
          <Button type="submit" pending={upload.isPending}>
            <Upload aria-hidden="true" />
            Upload and check
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

const ISSUE_TITLES: Record<Exclude<BatchRowValidation, 'ready'>, string> = {
  invalid: 'Rows with problems',
  duplicate: 'The same email address more than once',
  existing: 'People who already hold this achievement',
};

/** One batch: the mapping and validation report while it's a draft, then progress and results. */
export function BatchPage({ orgId, batchId }: { orgId: string; batchId: string }) {
  const { data: org } = useQuery(queries.org(orgId));
  const batch = useQuery({
    ...queries.batch(orgId, batchId),
    refetchInterval: (query) =>
      query.state.data && ['queued', 'running'].includes(query.state.data.status) ? 1500 : false,
  });
  if (!org || batch.isPending) return <Spinner />;
  if (batch.error || !batch.data) return <Alert variant="error">{errorMessage(batch.error)}</Alert>;
  const data = batch.data;
  const canAward = isWritable(org) && org.permissions.includes('credential:issue');

  return (
    <>
      <PageHeader
        icon={FileSpreadsheet}
        title={batchName(data)}
        description={`Award many: ${data.achievement.name}`}
        actions={<BatchStatusBadge status={data.status} />}
      />
      <OrgStatusBanner org={org} />
      <div className="mb-6">
        <Link
          to="/app/orgs/$orgId/award/many"
          params={{ orgId }}
          className="text-sm font-semibold text-link underline-offset-4 hover:underline"
        >
          ← All uploads
        </Link>
      </div>
      {data.status === 'draft' ? (
        <BatchDraft orgId={orgId} batch={data} canAward={canAward} />
      ) : (
        <BatchProgress orgId={orgId} batch={data} />
      )}
    </>
  );
}

function BatchDraft({
  orgId,
  batch,
  canAward,
}: {
  orgId: string;
  batch: BatchDetails;
  canAward: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const achievements = useQuery(queries.achievements(orgId, 'active'));
  const batchKey = queries.batch(orgId, batch.id).queryKey;
  // Only the answer to the latest change is shown: an earlier one would undo a later click.
  const latest = useRef(0);
  const update = useMutation({
    mutationFn: ({ body }: { body: UpdateBatchInput; seq: number }) =>
      patch<BatchDetails>(`/orgs/${orgId}/batches/${batch.id}`, body),
    onError: () => queryClient.invalidateQueries({ queryKey: batchKey }),
    onSuccess: async (updated, { seq }) => {
      if (seq !== latest.current) return;
      queryClient.setQueryData(batchKey, updated);
      await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'batch', batch.id, 'rows'] });
    },
  });
  /**
   * The choices as the person last made them. Kept in React state so a control shows a change in
   * the same event (a controlled checkbox would otherwise snap back until the server answers);
   * each saved answer, with the rows checked again, replaces it. Controls stay enabled while
   * saving, so keyboard focus never drops.
   */
  const fromServer = {
    hasHeader: batch.hasHeader,
    sendEmail: batch.options.sendEmail,
    awardExisting: batch.options.awardExisting,
    targets: batch.columns.map((column) => column.target),
  };
  const [choices, setChoices] = useState(fromServer);
  const serverChoices = JSON.stringify(fromServer);
  // Compared by value: a new answer from the server replaces the choices only if they changed.
  useEffect(() => setChoices(JSON.parse(serverChoices)), [serverChoices]);

  function change(body: UpdateBatchInput) {
    setChoices((current) => ({
      hasHeader: body.hasHeader ?? current.hasHeader,
      sendEmail: body.sendEmail ?? current.sendEmail,
      awardExisting: body.awardExisting ?? current.awardExisting,
      targets: body.columns ?? current.targets,
    }));
    latest.current += 1;
    update.mutate({ body, seq: latest.current });
  }
  const confirm = useMutation({
    mutationFn: () => post<BatchDetails>(`/orgs/${orgId}/batches/${batch.id}/confirm`),
    onSuccess: async (updated) => {
      queryClient.setQueryData(queries.batch(orgId, batch.id).queryKey, updated);
      await queryClient.invalidateQueries({ queryKey: queries.batches(orgId).queryKey });
    },
  });
  const discard = useMutation({
    mutationFn: () => del(`/orgs/${orgId}/batches/${batch.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queries.batches(orgId).queryKey });
      await navigate({ to: '/app/orgs/$orgId/award/many', params: { orgId } });
    },
  });

  const { counts, plan } = batch;
  const overLimit =
    plan.sendLimit.remaining !== null &&
    batch.options.sendEmail &&
    plan.emails > plan.sendLimit.remaining;
  const editable = canAward;
  const targets = choices.targets;
  const setTarget = (index: number, target: BatchColumnTarget) =>
    change({ columns: targets.map((current, i) => (i === index ? target : current)) });

  return (
    <div className="grid gap-6">
      {update.isError && <Alert variant="error">{errorMessage(update.error)}</Alert>}
      <Card>
        <CardHeader>
          <CardTitle>1. What the columns hold</CardTitle>
          <CardDescription>
            Recognized from the column names. Change any that are wrong; the rows are checked again
            straight away.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <Field label="Achievement">
            {(props) => (
              <Select
                {...props}
                value={batch.achievement.id}
                disabled={!editable}
                onChange={(event) => change({ achievementId: event.target.value })}
              >
                {(
                  achievements.data?.achievements ?? [
                    { id: batch.achievement.id, name: batch.achievement.name },
                  ]
                ).map((achievement) => (
                  <option key={achievement.id} value={achievement.id}>
                    {achievement.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {batch.source === 'csv' && (
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={choices.hasHeader}
                disabled={!editable}
                onChange={(event) => change({ hasHeader: event.target.checked })}
                className="mt-0.5 size-4 accent-[var(--color-link)]"
              />
              <span>
                <span className="font-semibold">The first line holds column names</span>
                <span className="block text-muted-foreground">
                  Untick it if the first line is already a person.
                </span>
              </span>
            </label>
          )}
          <ul className="grid gap-4 sm:grid-cols-2">
            {batch.columns.map((column, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are identified by position
              <li key={index}>
                <Field
                  label={`Column “${column.header}”`}
                  description={
                    column.samples.filter(Boolean).length > 0
                      ? `For example: ${column.samples.filter(Boolean).join(', ')}`
                      : 'Empty in the first rows.'
                  }
                >
                  {(props) => (
                    <Select
                      {...props}
                      value={choices.targets[index] ?? column.target}
                      disabled={!editable || batch.source === 'api'}
                      onChange={(event) =>
                        setTarget(index, event.target.value as BatchColumnTarget)
                      }
                    >
                      {BATCH_COLUMN_TARGETS.map((target) => (
                        <option key={target} value={target}>
                          {BATCH_COLUMN_LABELS[target]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Check the rows</CardTitle>
          <CardDescription>
            {plural(batch.totalRows, 'row')} in the file: {number(counts.ready)} ready
            {counts.invalid > 0 && `, ${number(counts.invalid)} with problems`}
            {counts.duplicate > 0 && `, ${number(counts.duplicate)} repeated`}
            {counts.existing > 0 && `, ${number(counts.existing)} already holding it`}.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {counts.ready === batch.totalRows ? (
            <Alert variant="success" live={false}>
              Every row is ready.
            </Alert>
          ) : (
            (['invalid', 'duplicate', 'existing'] as const)
              .filter((validation) => counts[validation] > 0)
              .map((validation) => (
                <RowList
                  key={validation}
                  orgId={orgId}
                  batchId={batch.id}
                  title={ISSUE_TITLES[validation]}
                  count={counts[validation]}
                  query={`validation=${validation}`}
                />
              ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Award</CardTitle>
          <CardDescription>
            {plan.toAward === 0
              ? 'No row can be awarded yet. Fix the file and upload it again, or change the columns above.'
              : `${plural(plan.toAward, 'badge')} will be signed and awarded${batch.options.sendEmail ? ', and each person emailed their link' : ''}. ${plan.toSkip > 0 ? `${plural(plan.toSkip, 'row')} will be skipped.` : ''}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={choices.sendEmail}
              disabled={!editable}
              onChange={(event) => change({ sendEmail: event.target.checked })}
              className="mt-0.5 size-4 accent-[var(--color-link)]"
            />
            <span>
              <span className="font-semibold">Email each person their link</span>
              <span className="block text-muted-foreground">
                {plan.sendLimit.remaining === null
                  ? 'Recommended: it’s how they get their badge.'
                  : `Recommended: it’s how they get their badge. This organization can send ${number(plan.sendLimit.remaining)} more award emails in the next 24 hours.`}
              </span>
            </span>
          </label>
          {counts.existing > 0 && (
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={choices.awardExisting}
                disabled={!editable}
                onChange={(event) => change({ awardExisting: event.target.checked })}
                className="mt-0.5 size-4 accent-[var(--color-link)]"
              />
              <span>
                <span className="font-semibold">Award again to people who already hold it</span>
                <span className="block text-muted-foreground">
                  {plural(counts.existing, 'person', 'people')} in the file already{' '}
                  {counts.existing === 1 ? 'has' : 'have'} this badge. Usually you skip them.
                </span>
              </span>
            </label>
          )}
          {overLimit && (
            <Alert variant="warning" title="Over the daily email limit">
              This would send {number(plan.emails)} emails, but this organization can send{' '}
              {number(plan.sendLimit.remaining ?? 0)} more in the next 24 hours. Award fewer people
              at once, award without email, or ask the people who run this credforge site to raise
              the limit.
            </Alert>
          )}
          {confirm.isError && (
            <Alert variant="error" title="Not awarded">
              {errorMessage(confirm.error)}
            </Alert>
          )}
          {discard.isError && <Alert variant="error">{errorMessage(discard.error)}</Alert>}
        </CardContent>
        {canAward && (
          <CardFooter className="flex flex-wrap gap-3">
            <ConfirmButton
              variant="default"
              confirmLabel="Award"
              question={`Award ${plural(plan.toAward, 'badge')}${batch.options.sendEmail ? ` and email ${plural(plan.emails, 'person', 'people')}` : ''}?`}
              pending={confirm.isPending}
              disabled={plan.toAward === 0 || overLimit || update.isPending}
              onConfirm={() => confirm.mutate()}
            >
              Award {plural(plan.toAward, 'badge')}
            </ConfirmButton>
            <ConfirmButton
              variant="outline"
              confirmLabel="Discard"
              question="Discard this upload? Nothing has been awarded from it."
              pending={discard.isPending}
              onConfirm={() => discard.mutate()}
            >
              Discard
            </ConfirmButton>
          </CardFooter>
        )}
      </Card>
    </div>
  );
}

const ROW_STATUS_WORDS: Record<BatchRowStatus, string> = {
  draft: 'not confirmed',
  pending: 'waiting',
  issued: 'awarded',
  failed: 'failed',
  skipped: 'skipped',
};

/** Rows matching a filter, with what's wrong with each; more on request. */
function RowList({
  orgId,
  batchId,
  title,
  count,
  query,
}: {
  orgId: string;
  batchId: string;
  title: string;
  count: number;
  query: string;
}) {
  const [limit, setLimit] = useState(20);
  const rows = useQuery(queries.batchRows(orgId, batchId, `${query}&limit=${limit}`));
  const id = `rows-${query.replace(/\W/g, '-')}`;
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="font-semibold">
        {title} ({number(count)})
      </h3>
      {rows.isPending ? (
        <Spinner />
      ) : (
        <ul className="mt-2 grid gap-2">
          {rows.data?.rows.map((row) => (
            <li key={row.rowNumber} className="rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="font-semibold break-words">
                Row {row.rowNumber}
                {row.values?.name ? ` · ${row.values.name}` : ''}
                {row.values?.email ? (
                  <span className="font-normal break-all text-muted-foreground">
                    {' '}
                    · {row.values.email}
                  </span>
                ) : null}
              </p>
              <p className="break-words text-muted-foreground">
                {row.error?.message ??
                  (row.issues.map((issue) => issue.message).join('. ') ||
                    ROW_STATUS_WORDS[row.status])}
              </p>
            </li>
          ))}
        </ul>
      )}
      {(rows.data?.rows.length ?? 0) < count && rows.data?.next !== null && (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          pending={rows.isFetching}
          onClick={() => setLimit((current) => Math.min(current + 100, 500))}
        >
          Show more
        </Button>
      )}
    </section>
  );
}

function BatchProgress({ orgId, batch }: { orgId: string; batch: BatchDetails }) {
  const queryClient = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);
  const { counts } = batch;
  const total = counts.pending + counts.issued + counts.failed;
  const done = counts.issued + counts.failed;
  const active = batch.status === 'queued' || batch.status === 'running';

  // The draft's form was swapped for this: move focus to the new heading.
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    if (!active) void queryClient.invalidateQueries({ queryKey: ['org', orgId, 'credentials'] });
  }, [active, orgId, queryClient]);

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle ref={heading} tabIndex={-1} className="outline-none">
            {active ? 'Awarding' : batch.status === 'completed' ? 'Awarded' : 'Stopped'}
          </CardTitle>
          <CardDescription>
            {active
              ? 'Each badge is signed and emailed on its own. You can leave this page: it carries on.'
              : batch.finishedAt
                ? `Finished ${formatDateTime(batch.finishedAt)}.`
                : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <label htmlFor="batch-progress" className="text-sm font-semibold">
              {number(done)} of {plural(total, 'badge')} handled
            </label>
            <progress
              id="batch-progress"
              max={Math.max(total, 1)}
              value={done}
              className="h-3 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
            />
          </div>
          <p role="status" className="text-sm">
            {active
              ? `${number(counts.issued)} awarded so far${counts.failed > 0 ? `, ${number(counts.failed)} failed` : ''}.`
              : batch.status === 'completed'
                ? `${plural(counts.issued, 'badge')} awarded${counts.failed > 0 ? `, ${number(counts.failed)} failed` : ''}${counts.skipped > 0 ? `, ${plural(counts.skipped, 'row')} skipped` : ''}.`
                : `${plural(counts.issued, 'badge')} awarded before it stopped.`}
          </p>
          {batch.status === 'failed' && batch.error && (
            <Alert variant="error" title="The batch stopped" live={false}>
              {batch.error}
            </Alert>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-3">
          <Button asChild variant="outline">
            <a href={`/api/v1/orgs/${orgId}/batches/${batch.id}/results.csv`} download>
              <Download aria-hidden="true" />
              Download the results (CSV)
            </a>
          </Button>
          <Button asChild variant="outline">
            <Link
              to="/app/orgs/$orgId/credentials"
              params={{ orgId }}
              search={{ batchId: batch.id }}
            >
              See these badges
            </Link>
          </Button>
        </CardFooter>
      </Card>
      {counts.failed > 0 && (
        <Card>
          <CardContent className="pt-6">
            <RowList
              orgId={orgId}
              batchId={batch.id}
              title="Failed"
              count={counts.failed}
              query="status=failed"
            />
          </CardContent>
        </Card>
      )}
      {counts.skipped > 0 && (
        <Card>
          <CardContent className="pt-6">
            <RowList
              orgId={orgId}
              batchId={batch.id}
              title="Skipped"
              count={counts.skipped}
              query="status=skipped"
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
