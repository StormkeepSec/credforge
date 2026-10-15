import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, Circle, Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageHeader } from '../components/app-shell';
import { isWritable, OrgStatusBadge, OrgStatusBanner } from '../components/org-status';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Spinner } from '../components/ui/feedback';
import { queries } from '../lib/api';

type StepState = 'done' | 'todo' | 'later';

function Step({
  state,
  title,
  children,
}: {
  state: StepState;
  title: ReactNode;
  children?: ReactNode;
}) {
  const Icon = state === 'done' ? CheckCircle2 : state === 'later' ? Clock : Circle;
  return (
    <li className="flex gap-3 py-3">
      <Icon
        className={
          state === 'done'
            ? 'mt-0.5 size-5 shrink-0 text-ok'
            : 'mt-0.5 size-5 shrink-0 text-muted-foreground'
        }
        aria-hidden="true"
      />
      <div className={state === 'later' ? 'text-muted-foreground' : undefined}>
        <p className="font-semibold">
          {title}
          <span className="sr-only">
            {state === 'done' ? ' (done)' : state === 'later' ? ' (coming later)' : ' (to do)'}
          </span>
        </p>
        {children && <div className="mt-0.5 text-sm text-muted-foreground">{children}</div>}
      </div>
    </li>
  );
}

const link = 'font-semibold text-link underline-offset-4 hover:underline';

/** The org's home: where it stands and the onboarding checklist (design plan §8.1). */
export function OrgOverviewPage({ orgId }: { orgId: string }) {
  const { data: org } = useQuery(queries.org(orgId));
  const { data: me } = useQuery(queries.me());
  const issuers = useQuery({
    ...queries.issuers(orgId),
    enabled: Boolean(org?.permissions.includes('issuer:read')),
  });
  const members = useQuery(queries.members(orgId));
  const achievements = useQuery({
    ...queries.achievements(orgId),
    enabled: Boolean(org?.permissions.includes('achievement:read')),
  });
  if (!org || !me) return <Spinner />;

  const hasIssuer = (issuers.data?.issuers.length ?? 0) > 0;
  const list = achievements.data?.achievements ?? [];
  const hasAchievement = list.some((achievement) => achievement.status !== 'draft');
  const hasAwarded = list.some((achievement) => achievement.awardedCount > 0);
  const canCreate = org.permissions.includes('achievement:write') && isWritable(org);
  const canAward = org.permissions.includes('credential:issue') && isWritable(org);
  const hasTeam = (members.data?.members.length ?? 0) > 1;
  const canEdit = org.permissions.includes('issuer:update') && isWritable(org);

  return (
    <>
      <PageHeader title={org.name} description={<OrgStatusBadge status={org.status} />} />
      <OrgStatusBanner org={org} />

      <Card>
        <CardHeader>
          <CardTitle>Get to your first badge</CardTitle>
          <CardDescription>
            Set up once; then every badge you award carries your issuer profile.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="divide-y">
            <Step state="done" title="Confirm your email address" />
            <Step state="done" title="Name your organization" />
            <Step
              state={me.user.twoFactorEnabled ? 'done' : 'todo'}
              title="Turn on two-step verification"
            >
              {me.user.twoFactorEnabled ? (
                'Your account asks for a code from your authenticator app.'
              ) : (
                <>
                  Protects your organization if your password leaks.{' '}
                  <Link to="/app/settings/two-factor" className={link}>
                    Turn it on
                  </Link>
                </>
              )}
            </Step>
            <Step state={hasIssuer ? 'done' : 'todo'} title="Set up your issuer profile">
              {hasIssuer ? (
                <>
                  Recipients and verifiers see it on every badge.{' '}
                  <Link to="/app/orgs/$orgId/issuer" params={{ orgId }} className={link}>
                    {canEdit ? 'Edit it' : 'View it'}
                  </Link>
                </>
              ) : (
                <>
                  Your name, logo, website and contact address, plus the key that signs your badges.{' '}
                  {canEdit && (
                    <Link to="/app/orgs/$orgId/issuer" params={{ orgId }} className={link}>
                      Set it up
                    </Link>
                  )}
                </>
              )}
            </Step>
            <Step state={hasTeam ? 'done' : 'todo'} title="Invite your team (optional)">
              <Link to="/app/orgs/$orgId/members" params={{ orgId }} className={link}>
                {hasTeam ? 'Manage members' : 'Invite people'}
              </Link>
            </Step>
            <Step state="later" title="Verify your website’s domain">
              Shows “Website verified” on your public pages. Coming in a later update.
            </Step>
            <Step
              state={hasAchievement ? 'done' : 'todo'}
              title="Create and publish your first achievement"
            >
              {hasAchievement ? (
                <>
                  Your achievements are ready to award.{' '}
                  <Link to="/app/orgs/$orgId/achievements" params={{ orgId }} className={link}>
                    See achievements
                  </Link>
                </>
              ) : (
                <>
                  A name, an image and how it is earned.{' '}
                  {canCreate && hasIssuer && (
                    <Link
                      to="/app/orgs/$orgId/achievements/new"
                      params={{ orgId }}
                      className={link}
                    >
                      Create one
                    </Link>
                  )}
                </>
              )}
            </Step>
            <Step state={hasAwarded ? 'done' : 'todo'} title="Award it to yourself">
              {hasAwarded ? (
                <>
                  You can see exactly what your recipients get.{' '}
                  <Link to="/app/orgs/$orgId/credentials" params={{ orgId }} className={link}>
                    See awarded badges
                  </Link>
                </>
              ) : (
                <>
                  See exactly what your recipients will get: the email, the badge page and the
                  download.{' '}
                  {canAward && hasAchievement && (
                    <Link to="/app/orgs/$orgId/award" params={{ orgId }} className={link}>
                      Award a badge
                    </Link>
                  )}
                </>
              )}
            </Step>
          </ol>
        </CardContent>
      </Card>
    </>
  );
}
