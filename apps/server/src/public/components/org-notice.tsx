import type { OrgStatus } from '@credforge/contracts';

const ISSUER_NOTICES: Partial<Record<OrgStatus, { title: string; body: string }>> = {
  pending: {
    title: 'Not reviewed yet',
    body: 'This organization is new and has not been approved by the people who run this credforge site yet.',
  },
  suspended: {
    title: 'Suspended',
    body: 'This organization is suspended and cannot award badges. Badges it awarded earlier can still be checked.',
  },
  declined: {
    title: 'Not approved',
    body: 'This organization was not approved to award badges on this credforge site.',
  },
};

const BADGE_NOTICES: Partial<Record<OrgStatus, { title: string; body: string }>> = {
  pending: {
    title: 'Awarded by an organization not reviewed yet',
    body: 'The organization behind this badge has not been approved by the people who run this credforge site yet. Until then it can only award badges to its own members.',
  },
  suspended: {
    title: 'Awarded by a suspended organization',
    body: 'The organization behind this badge is suspended on this credforge site and cannot award badges. Its earlier badges can still be checked.',
  },
  declined: {
    title: 'Awarded by an organization that was not approved',
    body: 'The organization behind this badge was not approved to award badges on this credforge site.',
  },
};

/**
 * What a visitor should know about the organization behind a public page (design plan §6.3):
 * nothing while it's active; otherwise that it's new, suspended or declined.
 */
export function OrgStatusNotice({
  status,
  subject,
  className = 'mt-8',
}: {
  status: OrgStatus;
  subject: 'issuer' | 'badge';
  className?: string;
}) {
  const notice = (subject === 'issuer' ? ISSUER_NOTICES : BADGE_NOTICES)[status];
  if (!notice) return null;
  return (
    <div
      role="note"
      className={`${className} rounded-lg border border-warning/40 bg-warning/5 p-4 text-ink`}
    >
      <p className="font-semibold">{notice.title}</p>
      <p className="mt-1 text-sm text-ink-muted">{notice.body}</p>
    </div>
  );
}
