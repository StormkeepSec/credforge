import type { OrgDetails, OrgStatus } from '@credforge/contracts';
import { Alert, Badge } from './ui/feedback';

const LABELS: Record<OrgStatus, string> = {
  pending: 'Waiting for approval',
  active: 'Approved',
  suspended: 'Suspended',
  declined: 'Not approved',
};

const VARIANTS = {
  pending: 'warning',
  active: 'success',
  suspended: 'danger',
  declined: 'danger',
} as const;

export function OrgStatusBadge({ status }: { status: OrgStatus }) {
  return <Badge variant={VARIANTS[status]}>{LABELS[status]}</Badge>;
}

/** What the org's status means for its members, shown on every org page (design plan §8.1). */
export function OrgStatusBanner({ org }: { org: OrgDetails }) {
  if (org.status === 'pending') {
    return (
      <Alert
        live={false}
        variant="warning"
        title={`${org.name} is waiting for approval`}
        className="mb-8"
      >
        You can set up your issuer profile and invite your team now. Once achievements arrive,
        you’ll be able to test-award them to your own members. Awarding to anyone else opens when a
        platform admin approves the organization; we’ll email the owners.
      </Alert>
    );
  }
  if (org.status === 'suspended') {
    return (
      <Alert live={false} variant="error" title={`${org.name} is suspended`} className="mb-8">
        It can’t award badges or send email, and its settings are read-only. Badges it already
        awarded stay verifiable.{org.statusReason && ` Reason: ${org.statusReason}`}
      </Alert>
    );
  }
  if (org.status === 'declined') {
    return (
      <Alert live={false} variant="error" title={`${org.name} wasn’t approved`} className="mb-8">
        It can’t award badges on this credforge site, and its settings are read-only.
        {org.statusReason && ` Reason: ${org.statusReason}`}
      </Alert>
    );
  }
  return null;
}

export function isWritable(org: OrgDetails): boolean {
  return org.status === 'pending' || org.status === 'active';
}
