import type { Achievement, ContentReview, Issuer } from '@credforge/contracts';
import { Alert, Badge } from './ui/feedback';

/**
 * What an org's members see of review (design plan §6.5): content waiting for the people who run
 * the site, and anything they removed. Neutral wording: waiting isn't a verdict.
 */

function parts(review: ContentReview, status: 'pending' | 'removed', image: string) {
  return [review.text === status && 'its text', review.image === status && image].filter(
    (part): part is string => Boolean(part),
  );
}

export function AchievementReview({ achievement }: { achievement: Achievement }) {
  if (achievement.removed) {
    return (
      <Alert live={false} variant="error" title="Unpublished by the people who run this site">
        It can’t be awarded, its page is gone and its badges’ pages no longer show its details.
        {achievement.removed.reason && ` Reason: ${achievement.removed.reason}`} Reply to the email
        about it to ask for it back.
      </Alert>
    );
  }
  const removed = parts(achievement.review, 'removed', 'its badge image');
  if (removed.length > 0) {
    return (
      <Alert live={false} variant="error" title={`Removed: ${removed.join(' and ')}`}>
        The people who run this site removed {removed.join(' and ')}. Change it to award this badge
        again; badges already awarded show a placeholder instead.
      </Alert>
    );
  }
  const waiting = parts(achievement.review, 'pending', 'its badge image');
  if (waiting.length === 0) return null;
  if (achievement.status === 'draft') {
    return (
      <p className="text-sm text-muted-foreground">
        Once you publish it, the people who run this site review {waiting.join(' and ')} before its
        public page shows {waiting.length === 1 ? 'it' : 'them'}.
      </p>
    );
  }
  return (
    <Alert live={false} variant="warning" title="Waiting for review">
      The people who run this site review {waiting.join(' and ')} before the public page shows{' '}
      {waiting.length === 1 ? 'it' : 'them'}. Until then you can award it only to your
      organization’s members, and their badges’ pages stay private.
    </Alert>
  );
}

export function IssuerReview({ issuer }: { issuer: Issuer }) {
  const removed = parts(issuer.review, 'removed', 'its logo');
  if (removed.length > 0) {
    return (
      <Alert live={false} variant="error" title={`Removed: ${removed.join(' and ')}`}>
        The people who run this site removed {removed.join(' and ')} of your issuer profile. Change
        it to award badges again.
      </Alert>
    );
  }
  const waiting = parts(issuer.review, 'pending', 'its logo');
  if (waiting.length === 0) return null;
  return (
    <Alert live={false} variant="warning" title="Waiting for review">
      The people who run this site review {waiting.join(' and ')} of your issuer profile before
      public pages show {waiting.length === 1 ? 'it' : 'them'}. Until then badges can be awarded
      only to your organization’s members.
    </Alert>
  );
}

/** A small badge for lists: waiting, or removed. */
export function ReviewBadge({ achievement }: { achievement: Achievement }) {
  if (
    achievement.removed ||
    [achievement.review.text, achievement.review.image].includes('removed')
  ) {
    return <Badge variant="danger">Removed by the site</Badge>;
  }
  if (
    achievement.status !== 'draft' &&
    [achievement.review.text, achievement.review.image].includes('pending')
  ) {
    return <Badge variant="warning">Waiting for review</Badge>;
  }
  return null;
}
