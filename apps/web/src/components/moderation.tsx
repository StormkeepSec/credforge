import {
  type ModerationItem,
  REPORT_CATEGORY_LABELS,
  type ReportCategory,
} from '@credforge/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { errorMessage, post } from '../lib/api';
import { formatDate } from '../lib/utils';
import { OrgStatusBadge } from './org-status';
import { Button, type ButtonProps } from './ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Alert, Badge } from './ui/feedback';
import { Field, Textarea } from './ui/input';

/**
 * The moderation queue's building blocks (design plan §6.5): an item of held content with its
 * image blurred until the admin chooses to see it, and the actions that take a reason, asked in
 * place (no modal dialogs: their scroll lock needs inline styles, which the CSP blocks).
 */

export const KIND_LABELS: Record<string, string> = {
  'achievement:image': 'Badge image',
  'issuer:image': 'Issuer logo',
  'achievement:text': 'Achievement text',
  'issuer:text': 'Issuer profile',
  'organization:text': 'Organization name',
};

export function categoryLabel(category: string | null): string {
  return category ? (REPORT_CATEGORY_LABELS[category as ReportCategory] ?? category) : 'Report';
}

/**
 * A flagged image: blurred on the server (the real pixels aren't even sent) until the admin asks
 * to see it. Never offered as a download.
 */
export function ModerationImage({ item }: { item: ModerationItem }) {
  const [revealed, setRevealed] = useState(false);
  const src = `/api/v1/platform/moderation/items/${item.id}/image?view=${revealed ? 'full' : 'blurred'}`;
  return (
    <div className="grid justify-items-start gap-2">
      <img
        src={src}
        alt={
          revealed ? `${KIND_LABELS[`${item.subject.type}:image`]} under review` : 'Blurred image'
        }
        width={160}
        height={160}
        draggable={false}
        className="size-40 rounded-md border bg-muted object-contain"
      />
      <Button size="sm" variant="outline" onClick={() => setRevealed((value) => !value)}>
        {revealed ? 'Blur again' : 'Show image'}
      </Button>
    </div>
  );
}

/**
 * An action that needs a reason (sent to the organization's owners): the button opens a short
 * form in place. Focus moves into it, and back to the button when it closes.
 */
export function ReasonButton({
  label,
  confirmLabel,
  reasonLabel = 'Reason (emailed to the organization’s owners)',
  extra,
  onConfirm,
  pending,
  variant = 'outline',
  size = 'sm',
}: {
  label: string;
  confirmLabel: string;
  reasonLabel?: string;
  /** More fields, rendered under the reason. */
  extra?: ReactNode;
  onConfirm: (reason: string) => void;
  pending?: boolean;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [open]);

  const close = () => {
    restoreFocus.current = true;
    setOpen(false);
    setReason('');
  };

  if (!open) {
    return (
      <Button ref={trigger} size={size} variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  return (
    <form
      className="grid w-full gap-3 rounded-md border bg-muted/40 p-3"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (reason.trim()) onConfirm(reason.trim());
      }}
    >
      <Field label={reasonLabel}>
        {(props) => (
          <Textarea
            {...props}
            autoFocus
            rows={2}
            maxLength={1000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </Field>
      {extra}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          variant="destructive"
          pending={pending}
          disabled={!reason.trim()}
        >
          {confirmLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Flags({ item }: { item: ModerationItem }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Why it is here">
      {item.flags.map((flag) => (
        <li key={`${flag.source}-${flag.at}-${flag.reportId ?? ''}`}>
          {flag.source === 'review' ? (
            <Badge variant="neutral">New or changed</Badge>
          ) : flag.source === 'blocklist' ? (
            <Badge variant="warning">Word list: {flag.terms?.join(', ')}</Badge>
          ) : (
            <Badge variant={flag.category === 'child_safety' ? 'danger' : 'warning'}>
              Reported: {categoryLabel(flag.category)}
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

const STATUS_LABELS = { pending: 'Waiting', cleared: 'Cleared', removed: 'Removed' } as const;

/**
 * One item of the queue with what can be done about it. `onDone` hears what happened, for the
 * page's status message. `orgActions: false` leaves out the actions on the whole organization
 * (on the Platform screen's org card, which has its own).
 */
export function ModerationItemCard({
  item,
  onDone,
  orgActions = true,
}: {
  item: ModerationItem;
  onDone: (message: string) => void;
  orgActions?: boolean;
}) {
  const queryClient = useQueryClient();
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown; done: string }) =>
      post(path, body ?? {}),
    onSuccess: async (_result, { done }) => {
      onDone(done);
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
  });
  const kind = KIND_LABELS[`${item.subject.type}:${item.kind}`] ?? 'Content';
  const what = item.kind === 'image' ? 'image' : 'text';
  const titleId = `item-${item.id}-title`;
  const run = (path: string, done: string, body?: unknown) => act.mutate({ path, body, done });

  return (
    <Card aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId} className="flex flex-wrap items-center gap-2 text-base">
          {kind}
          {item.subject.name && <span className="font-normal">· {item.subject.name}</span>}
          <Badge variant={item.status === 'removed' ? 'danger' : 'neutral'}>
            {STATUS_LABELS[item.status]}
          </Badge>
        </CardTitle>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {item.org.name}
          <OrgStatusBadge status={item.org.status} />
          {item.org.trusted && <Badge variant="success">Trusted</Badge>}
          {item.subject.pageUrl && (
            <a
              href={item.subject.pageUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-link underline"
            >
              Public page
              <ExternalLink className="size-3" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
        </p>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <Flags item={item} />
        {item.kind === 'image' ? (
          <ModerationImage item={item} />
        ) : (
          <dl className="grid gap-3">
            {item.text?.map((field) => (
              <div key={field.field}>
                <dt className="font-semibold">{field.label}</dt>
                <dd className="mt-0.5 break-words whitespace-pre-line text-muted-foreground">
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <p className="text-muted-foreground">
          {item.submittedBy
            ? `Saved by ${item.submittedBy.name} (${item.submittedBy.email})`
            : 'Saved'}{' '}
          on {formatDate(item.submittedAt)}
          {item.heldCredentials > 0 &&
            ` · ${item.heldCredentials} ${item.heldCredentials === 1 ? 'badge waits' : 'badges wait'} for it`}
          {item.subject.removed && ' · Achievement unpublished'}
        </p>
        {item.decidedAt && (
          <p className="text-muted-foreground">
            {item.status === 'removed' ? 'Removed' : 'Decided'} on {formatDate(item.decidedAt)}
            {item.decidedBy ? ` by ${item.decidedBy.name}` : ''}
            {item.decisionNote ? `: ${item.decisionNote}` : ''}
          </p>
        )}
        {act.isError && <Alert variant="error">{errorMessage(act.error)}</Alert>}
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        {item.status !== 'cleared' && (
          <Button
            size="sm"
            pending={act.isPending}
            onClick={() =>
              run(`/platform/moderation/items/${item.id}/clear`, `${kind} cleared and published.`)
            }
          >
            {item.status === 'removed' ? 'Put back' : 'Clear and publish'}
          </Button>
        )}
        {item.status !== 'removed' && (
          <ReasonButton
            label={`Remove ${what}`}
            confirmLabel={`Remove ${what}`}
            pending={act.isPending}
            onConfirm={(reason) =>
              run(`/platform/moderation/items/${item.id}/remove`, `${kind} removed.`, { reason })
            }
          />
        )}
        {item.subject.type === 'achievement' && item.subject.pageUrl && !item.subject.removed && (
          <ReasonButton
            label="Unpublish achievement"
            confirmLabel="Unpublish"
            pending={act.isPending}
            onConfirm={(reason) =>
              run(
                `/platform/achievements/${item.subject.id}/unpublish`,
                'Achievement unpublished.',
                { reason },
              )
            }
          />
        )}
        {orgActions && <OrgActions org={item.org} run={run} pending={act.isPending} />}
        {item.submittedBy && !item.submittedBy.disabled && (
          <ReasonButton
            label={`Disable ${item.submittedBy.name}’s account`}
            confirmLabel="Disable account"
            reasonLabel="Reason (emailed to them and the organization’s owners)"
            pending={act.isPending}
            onConfirm={(reason) =>
              run(`/platform/users/${item.submittedBy?.id}/disable`, 'Account disabled.', {
                reason,
                orgId: item.org.id,
              })
            }
          />
        )}
      </CardFooter>
    </Card>
  );
}

/** Suspending the organization, then revoking every badge it awarded. */
export function OrgActions({
  org,
  run,
  pending,
}: {
  org: ModerationItem['org'];
  run: (path: string, done: string, body?: unknown) => void;
  pending: boolean;
}) {
  const [publicReason, setPublicReason] = useState('');
  if (org.status === 'active' || org.status === 'pending') {
    return (
      <ReasonButton
        label="Suspend organization"
        confirmLabel="Suspend"
        pending={pending}
        onConfirm={(reason) =>
          run(`/platform/orgs/${org.id}/suspend`, 'Organization suspended.', { reason })
        }
      />
    );
  }
  if (org.status !== 'suspended') return null;
  return (
    <ReasonButton
      label="Revoke all its badges"
      confirmLabel="Revoke every badge"
      pending={pending}
      extra={
        <Field
          label="Reason shown on each badge’s page (optional)"
          description="Every badge it awarded will check as revoked. This can’t be undone."
        >
          {(props) => (
            <Textarea
              {...props}
              rows={2}
              maxLength={500}
              value={publicReason}
              onChange={(event) => setPublicReason(event.target.value)}
            />
          )}
        </Field>
      }
      onConfirm={(reason) =>
        run(`/platform/orgs/${org.id}/revoke-credentials`, 'Badges revoked.', {
          reason,
          ...(publicReason.trim() && { publicReason: publicReason.trim() }),
        })
      }
    />
  );
}
