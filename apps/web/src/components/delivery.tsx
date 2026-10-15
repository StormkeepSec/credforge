import type { AchievementStatus, DeliveryStatus } from '@credforge/contracts';
import { Badge } from './ui/feedback';

const DELIVERY: Record<
  DeliveryStatus,
  { label: string; variant: 'neutral' | 'success' | 'warning' | 'danger' }
> = {
  not_sent: { label: 'Not emailed', variant: 'neutral' },
  queued: { label: 'Queued', variant: 'neutral' },
  sent: { label: 'Sent', variant: 'neutral' },
  delivered: { label: 'Delivered', variant: 'success' },
  bounced: { label: 'Bounced', variant: 'danger' },
  dropped: { label: 'Not delivered', variant: 'danger' },
  spam_reported: { label: 'Marked as spam', variant: 'danger' },
  failed: { label: 'Failed', variant: 'danger' },
};

export function deliveryLabel(status: DeliveryStatus): string {
  return DELIVERY[status].label;
}

/** Where the award email stands (design plan §8.4). */
export function DeliveryBadge({ status }: { status: DeliveryStatus }) {
  const { label, variant } = DELIVERY[status];
  return (
    <Badge variant={variant}>
      <span className="sr-only">Email: </span>
      {label}
    </Badge>
  );
}

const ACHIEVEMENT: Record<
  AchievementStatus,
  { label: string; variant: 'neutral' | 'success' | 'warning' }
> = {
  draft: { label: 'Draft', variant: 'warning' },
  active: { label: 'Published', variant: 'success' },
  archived: { label: 'Archived', variant: 'neutral' },
};

export function AchievementStatusBadge({ status }: { status: AchievementStatus }) {
  const { label, variant } = ACHIEVEMENT[status];
  return <Badge variant={variant}>{label}</Badge>;
}
