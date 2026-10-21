import { achievementTypeLabel } from '@credforge/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Award, Plus } from 'lucide-react';
import { PageHeader } from '../components/app-shell';
import { AchievementStatusBadge } from '../components/delivery';
import { isWritable, OrgStatusBanner } from '../components/org-status';
import { ReviewBadge } from '../components/review';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Alert, Spinner } from '../components/ui/feedback';
import { errorMessage, queries } from '../lib/api';

/** The org's achievements as a grid of badge cards (design plan §11.1). */
export function AchievementsPage({ orgId }: { orgId: string }) {
  const { data: org } = useQuery(queries.org(orgId));
  const issuers = useQuery(queries.issuers(orgId));
  const { data, isPending, error } = useQuery(queries.achievements(orgId));
  if (!org || isPending || issuers.isPending) return <Spinner />;

  const canWrite = isWritable(org) && org.permissions.includes('achievement:write');
  const hasIssuer = (issuers.data?.issuers.length ?? 0) > 0;
  const achievements = data?.achievements ?? [];

  return (
    <>
      <PageHeader
        icon={Award}
        title="Achievements"
        description="What your organization awards. Each one becomes a badge with its own page."
        actions={
          canWrite &&
          hasIssuer && (
            <Button asChild>
              <Link to="/app/orgs/$orgId/achievements/new" params={{ orgId }}>
                <Plus aria-hidden="true" />
                Create achievement
              </Link>
            </Button>
          )
        }
      />
      <OrgStatusBanner org={org} />
      {error && <Alert variant="error">{errorMessage(error)}</Alert>}
      {!hasIssuer && (
        <Alert variant="info" title="Set up your issuer profile first" className="mb-6">
          Badges are awarded in the name of your issuer profile.{' '}
          <Link to="/app/orgs/$orgId/issuer" params={{ orgId }}>
            Go to the issuer profile
          </Link>
        </Alert>
      )}
      {achievements.length === 0 ? (
        hasIssuer && (
          <Card>
            <CardContent className="grid justify-items-start gap-3">
              <p className="font-semibold">No achievements yet</p>
              <p className="text-sm text-muted-foreground">
                Create one for the skill, course or milestone you want to recognize, then award it.
              </p>
            </CardContent>
          </Card>
        )
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {achievements.map((achievement) => (
            <li key={achievement.id}>
              <Link
                to="/app/orgs/$orgId/achievements/$achievementId"
                params={{ orgId, achievementId: achievement.id }}
                className="flex h-full gap-4 rounded-xl border bg-card p-4 hover:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
                  {achievement.image ? (
                    <img
                      src={achievement.image.url128}
                      alt=""
                      className="size-full object-contain"
                    />
                  ) : (
                    <Award className="size-7 text-muted-foreground" aria-hidden="true" />
                  )}
                </div>
                <div className="grid min-w-0 content-start gap-1.5">
                  <p className="font-semibold break-words">{achievement.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {achievementTypeLabel(achievement.achievementType)} · awarded{' '}
                    {achievement.awardedCount} {achievement.awardedCount === 1 ? 'time' : 'times'}
                  </p>
                  <span className="flex flex-wrap gap-1.5">
                    <AchievementStatusBadge status={achievement.status} />
                    <ReviewBadge achievement={achievement} />
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
