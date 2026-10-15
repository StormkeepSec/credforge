import type { AchievementStatus } from '@credforge/contracts';
import { Badge } from './ui/feedback';

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
