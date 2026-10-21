import type {
  ContentReport,
  ModerationStatus,
  ModerationSummary,
  ReportStatus,
} from '@credforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Flag } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '../components/app-shell';
import { categoryLabel, ModerationItemCard } from '../components/moderation';
import { OrgStatusBadge } from '../components/org-status';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Alert, Badge, Spinner } from '../components/ui/feedback';
import { Field, Textarea } from '../components/ui/input';
import { errorMessage, post, queries } from '../lib/api';
import { cn, formatDate } from '../lib/utils';

type View = { kind: 'items'; status: ModerationStatus } | { kind: 'reports'; status: ReportStatus };

const WAITING: View = { kind: 'items', status: 'pending' };

const VIEWS: { key: string; label: string; view: View }[] = [
  { key: 'pending', label: 'Waiting for review', view: WAITING },
  { key: 'reports', label: 'Reports', view: { kind: 'reports', status: 'open' } },
  { key: 'cleared', label: 'Cleared', view: { kind: 'items', status: 'cleared' } },
  { key: 'removed', label: 'Removed', view: { kind: 'items', status: 'removed' } },
  { key: 'resolved', label: 'Resolved reports', view: { kind: 'reports', status: 'resolved' } },
  { key: 'dismissed', label: 'Dismissed reports', view: { kind: 'reports', status: 'dismissed' } },
];

function ReportCard({
  report,
  onDone,
}: {
  report: ContentReport;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const resolve = useMutation({
    mutationFn: (status: 'resolved' | 'dismissed') =>
      post(`/platform/reports/${report.id}/resolve`, {
        status,
        ...(note.trim() && { note: note.trim() }),
      }),
    onSuccess: async (_result, status) => {
      onDone(status === 'resolved' ? 'Report resolved.' : 'Report dismissed.');
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
  });
  const childSafety = report.category === 'child_safety';
  const titleId = `report-${report.id}-title`;
  return (
    <Card aria-labelledby={titleId} className={cn(childSafety && 'border-destructive/50')}>
      <CardHeader>
        <CardTitle id={titleId} className="flex flex-wrap items-center gap-2 text-base">
          {categoryLabel(report.category)}
          {childSafety && <Badge variant="danger">Child safety</Badge>}
          {report.status !== 'open' && (
            <Badge variant="neutral">
              {report.status === 'resolved' ? 'Resolved' : 'Dismissed'}
            </Badge>
          )}
        </CardTitle>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          Reported {formatDate(report.createdAt)} about{' '}
          <a
            href={report.target.pageUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-link underline"
          >
            {report.target.name}
            <ExternalLink className="size-3" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          · {report.org.name}
          <OrgStatusBadge status={report.org.status} />
        </p>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {report.details ? (
          <blockquote className="border-l-4 pl-4 whitespace-pre-line">{report.details}</blockquote>
        ) : (
          <p className="text-muted-foreground">No details given.</p>
        )}
        {report.reporterEmail && (
          <p>
            Reply to:{' '}
            <a href={`mailto:${report.reporterEmail}`} className="text-link underline">
              {report.reporterEmail}
            </a>
          </p>
        )}
        {report.heldItemIds.length > 0 && (
          <Alert live={false} variant="warning" title="Its images were held at once">
            They show as a placeholder on public pages until you clear or remove them below.
          </Alert>
        )}
        {report.resolvedAt && (
          <p className="text-muted-foreground">
            {report.status === 'resolved' ? 'Resolved' : 'Dismissed'} on{' '}
            {formatDate(report.resolvedAt)}
            {report.resolvedBy ? ` by ${report.resolvedBy.name}` : ''}
            {report.resolutionNote ? `: ${report.resolutionNote}` : ''}
          </p>
        )}
        {report.items.length > 0 && (
          <div className="grid gap-4">
            <p className="font-semibold">What the page shows</p>
            {report.items.map((item) => (
              <ModerationItemCard key={item.id} item={item} onDone={onDone} />
            ))}
          </div>
        )}
        {resolve.isError && <Alert variant="error">{errorMessage(resolve.error)}</Alert>}
      </CardContent>
      {report.status === 'open' && (
        <CardFooter className="grid gap-3">
          <Field label="Note for the record (optional)">
            {(props) => (
              <Textarea
                {...props}
                rows={2}
                maxLength={1000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              pending={resolve.isPending}
              onClick={() => resolve.mutate('resolved')}
            >
              Resolve
            </Button>
            <Button
              size="sm"
              variant="outline"
              pending={resolve.isPending}
              onClick={() => resolve.mutate('dismissed')}
            >
              Dismiss
            </Button>
          </div>
        </CardFooter>
      )}
    </Card>
  );
}

/** Which automatic checks run on this instance (design plan §6.5, decision 60). */
function ScanningStatus({ scanning }: { scanning: ModerationSummary['scanning'] }) {
  const checks = [scanning.images && 'images', scanning.text && 'public text']
    .filter(Boolean)
    .join(' and ');
  return (
    <p className="mb-4 text-sm text-muted-foreground">
      {scanning.provider
        ? `Automatic check: ${scanning.provider} scores new ${checks}.`
        : 'No automatic check is set up: content waits for people only.'}{' '}
      {scanning.csamMatcher
        ? `Images are matched against known CSAM by ${scanning.csamMatcher}.`
        : 'No known-CSAM matching is set up.'}
      {scanning.waiting > 0 && ` ${scanning.waiting} waiting for their check.`}
      {scanning.failed > 0 &&
        ` ${scanning.failed} ${scanning.failed === 1 ? 'check' : 'checks'} gave up: look at ${scanning.failed === 1 ? 'it' : 'them'} yourself.`}
    </p>
  );
}

/**
 * Platform admins: the moderation queue (design plan §6.5). Content waiting for review (images
 * blurred until asked), reports from public pages, and what was cleared or removed.
 */
export function PlatformModerationPage() {
  const [key, setKey] = useState('pending');
  const [message, setMessage] = useState('');
  const view = VIEWS.find((entry) => entry.key === key)?.view ?? WAITING;
  const summary = useQuery(queries.moderationSummary());
  const items = useQuery({
    ...queries.moderationItems(view.kind === 'items' ? view.status : 'pending'),
    enabled: view.kind === 'items',
  });
  const reports = useQuery({
    ...queries.reports(view.kind === 'reports' ? view.status : 'open'),
    enabled: view.kind === 'reports',
  });
  const active = view.kind === 'items' ? items : reports;
  const counts: Record<string, number | undefined> = {
    pending: summary.data?.pendingItems,
    reports: summary.data?.openReports,
  };

  return (
    <>
      <PageHeader
        icon={Flag}
        title="Moderation"
        description="Images and text waiting for review, and reports from public pages. Images stay blurred until you choose to see them."
      />
      {summary.data && <ScanningStatus scanning={summary.data.scanning} />}
      <fieldset className="mb-6 min-w-0">
        <legend className="sr-only">Show</legend>
        <div className="flex flex-wrap gap-2">
          {VIEWS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              aria-pressed={key === entry.key}
              onClick={() => {
                setMessage('');
                setKey(entry.key);
              }}
              className={cn(
                'rounded-full border px-4 py-1.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                key === entry.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'bg-card hover:bg-muted',
              )}
            >
              {entry.label}
              {counts[entry.key] !== undefined && ` (${counts[entry.key]})`}
            </button>
          ))}
        </div>
      </fieldset>
      <p role="status" className="mb-4 text-sm font-semibold">
        {message}
      </p>
      <div className="grid gap-4">
        {active.isPending && <Spinner />}
        {active.isError && <Alert variant="error">{errorMessage(active.error)}</Alert>}
        {view.kind === 'items' &&
          items.data &&
          (items.data.items.length === 0 ? (
            <p className="text-muted-foreground">
              {view.status === 'pending' ? 'Nothing waiting for review.' : 'Nothing here.'}
            </p>
          ) : (
            items.data.items.map((item) => (
              <ModerationItemCard key={item.id} item={item} onDone={setMessage} />
            ))
          ))}
        {view.kind === 'reports' &&
          reports.data &&
          (reports.data.reports.length === 0 ? (
            <p className="text-muted-foreground">
              {view.status === 'open' ? 'No open reports.' : 'None.'}
            </p>
          ) : (
            reports.data.reports.map((report) => (
              <ReportCard key={report.id} report={report} onDone={setMessage} />
            ))
          ))}
      </div>
    </>
  );
}
