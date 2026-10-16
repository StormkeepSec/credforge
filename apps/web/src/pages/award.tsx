import {
  type Achievement,
  type AwardInput,
  type AwardPreview,
  awardInput,
  type CredentialDetails,
} from '@credforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, ExternalLink, Send } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../components/app-shell';
import { AwardTabs } from '../components/award-tabs';
import { BadgePreview } from '../components/badge-preview';
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
import { Alert, Spinner } from '../components/ui/feedback';
import { Field, Input, Select, Textarea } from '../components/ui/input';
import { ApiError, errorMessage, post, queries } from '../lib/api';

interface Form {
  achievementId: string;
  name: string;
  email: string;
  issuedOn: string;
  expiresOn: string;
  evidenceUrl: string;
  evidenceNarrative: string;
  sendEmail: boolean;
}

/** Today as YYYY-MM-DD in the person's own time zone. */
const today = () => new Date().toLocaleDateString('en-CA');

function toBody(form: Form): AwardInput {
  const evidence =
    form.evidenceUrl.trim() || form.evidenceNarrative.trim()
      ? [{ url: form.evidenceUrl, narrative: form.evidenceNarrative }]
      : undefined;
  return {
    achievementId: form.achievementId,
    recipient: { name: form.name, email: form.email },
    issuedOn: form.issuedOn || undefined,
    expiresOn: form.expiresOn || undefined,
    evidence,
    sendEmail: form.sendEmail,
  };
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Award one badge (design plan §8.2): choose the achievement, enter the recipient, preview their
 * page and the email, then award. The server signs and stores it and queues the email.
 */
export function AwardPage({ orgId, achievementId }: { orgId: string; achievementId?: string }) {
  const { data: org } = useQuery(queries.org(orgId));
  const { data: me } = useQuery(queries.me());
  const issuers = useQuery(queries.issuers(orgId));
  const achievements = useQuery(queries.achievements(orgId, 'active'));
  const [awarded, setAwarded] = useState<CredentialDetails | null>(null);
  const [round, setRound] = useState(0);
  if (!org || !me || issuers.isPending || achievements.isPending) return <Spinner />;

  const canAward = isWritable(org) && org.permissions.includes('credential:issue');
  const options = achievements.data?.achievements ?? [];

  return (
    <>
      <PageHeader
        icon={Send}
        title="Award a badge"
        description="Signed with your issuer’s key and emailed to the recipient."
      />
      <OrgStatusBanner org={org} />
      <AwardTabs orgId={orgId} current="one" />
      {!canAward ? (
        <Alert variant="info">Your role can’t award badges in this organization.</Alert>
      ) : options.length === 0 ? (
        <Alert variant="info" title="Nothing to award yet">
          Publish an achievement first.{' '}
          <Link to="/app/orgs/$orgId/achievements" params={{ orgId }}>
            Go to achievements
          </Link>
        </Alert>
      ) : awarded ? (
        <Awarded
          orgId={orgId}
          credential={awarded}
          onAnother={() => {
            setAwarded(null);
            setRound((current) => current + 1);
          }}
        />
      ) : (
        <AwardForm
          key={round}
          orgId={orgId}
          pending={org.status === 'pending'}
          dailySendLimit={org.dailySendLimit}
          me={{ name: me.user.name, email: me.user.email }}
          issuerName={issuers.data?.issuers[0]?.name ?? ''}
          achievements={options}
          initialAchievementId={
            options.some((option) => option.id === achievementId)
              ? (achievementId as string)
              : (options[0]?.id ?? '')
          }
          onAwarded={setAwarded}
        />
      )}
    </>
  );
}

function AwardForm({
  orgId,
  pending,
  dailySendLimit,
  me,
  issuerName,
  achievements,
  initialAchievementId,
  onAwarded,
}: {
  orgId: string;
  pending: boolean;
  dailySendLimit: number | null;
  me: { name: string; email: string };
  issuerName: string;
  achievements: Achievement[];
  initialAchievementId: string;
  onAwarded: (credential: CredentialDetails) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form>({
    achievementId: initialAchievementId,
    name: '',
    email: '',
    issuedOn: today(),
    expiresOn: '',
    evidenceUrl: '',
    evidenceNarrative: '',
    sendEmail: true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const selected = achievements.find((achievement) => achievement.id === form.achievementId);
  const previewName = useDebounced(form.name, 400);

  const emailPreview = useQuery({
    queryKey: ['org', orgId, 'award-preview', form.achievementId, previewName],
    queryFn: () =>
      post<AwardPreview>(`/orgs/${orgId}/credentials/preview`, {
        achievementId: form.achievementId,
        recipient: { name: previewName },
      }),
    enabled: Boolean(form.achievementId),
    staleTime: 60_000,
  });

  const award = useMutation({
    mutationFn: (body: AwardInput) => post<CredentialDetails>(`/orgs/${orgId}/credentials`, body),
    onSuccess: async (credential) => {
      await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'achievements'] });
      await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'credentials'] });
      onAwarded(credential);
    },
    onError: (error) => {
      if (error instanceof ApiError) setErrors(error.fieldErrors);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = toBody(form);
    const parsed = awardInput.safeParse(body);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues)
        next[issue.path.map(String).join('.')] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    award.mutate(body);
  }

  const set = (key: keyof Form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[1fr_20rem]">
      <Card>
        <form onSubmit={onSubmit} noValidate>
          <CardHeader>
            <CardTitle>Recipient and badge</CardTitle>
            <CardDescription>
              {pending
                ? 'While your organization waits for approval, you can award badges only to its members, at their confirmed email addresses. Try one on yourself.'
                : 'The recipient doesn’t need an account: the email links to their badge.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            {award.isError && Object.keys(errors).length === 0 && (
              <Alert variant="error" title="Not awarded">
                {errorMessage(award.error)}
              </Alert>
            )}
            <Field label="Achievement" error={errors.achievementId}>
              {(props) => (
                <Select {...props} value={form.achievementId} onChange={set('achievementId')}>
                  {achievements.map((achievement) => (
                    <option key={achievement.id} value={achievement.id}>
                      {achievement.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Recipient’s name" error={errors['recipient.name']}>
                {(props) => (
                  <Input {...props} autoComplete="off" value={form.name} onChange={set('name')} />
                )}
              </Field>
              <Field label="Recipient’s email address" error={errors['recipient.email']}>
                {(props) => (
                  <Input
                    {...props}
                    type="email"
                    autoComplete="off"
                    value={form.email}
                    onChange={set('email')}
                  />
                )}
              </Field>
            </div>
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setForm((current) => ({ ...current, name: me.name, email: me.email }))
                }
              >
                Award it to myself
              </Button>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Awarded on" description="When it was earned." error={errors.issuedOn}>
                {(props) => (
                  <Input
                    {...props}
                    type="date"
                    max={today()}
                    value={form.issuedOn}
                    onChange={set('issuedOn')}
                  />
                )}
              </Field>
              <Field
                label="Expires on (optional)"
                description={
                  selected?.validForDays
                    ? `Empty: ${selected.validForDays} days after the award date.`
                    : 'Empty: it doesn’t expire.'
                }
                error={errors.expiresOn}
              >
                {(props) => (
                  <Input
                    {...props}
                    type="date"
                    value={form.expiresOn}
                    onChange={set('expiresOn')}
                  />
                )}
              </Field>
            </div>
            <fieldset className="grid gap-4">
              <legend className="float-left w-full text-sm font-semibold">
                Evidence (optional)
              </legend>
              <p className="-mt-2 text-sm text-muted-foreground">
                Work that shows what the recipient did, such as a project or a portfolio page.
              </p>
              <Field label="Link" error={errors['evidence.0.url']}>
                {(props) => (
                  <Input
                    {...props}
                    type="url"
                    placeholder="https://example.org/portfolio/jordan"
                    value={form.evidenceUrl}
                    onChange={set('evidenceUrl')}
                  />
                )}
              </Field>
              <Field label="Description" error={errors['evidence.0.narrative']}>
                {(props) => (
                  <Textarea
                    {...props}
                    value={form.evidenceNarrative}
                    onChange={set('evidenceNarrative')}
                  />
                )}
              </Field>
            </fieldset>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={form.sendEmail}
                onChange={(event) =>
                  setForm((current) => ({ ...current, sendEmail: event.target.checked }))
                }
                className="mt-0.5 size-4 accent-[var(--color-link)]"
              />
              <span>
                <span className="font-semibold">Email the recipient their link</span>
                <span className="block text-muted-foreground">
                  {dailySendLimit === null
                    ? 'Recommended: it’s how they get their badge.'
                    : `Recommended: it’s how they get their badge. This organization can send ${dailySendLimit.toLocaleString()} award emails a day.`}
                </span>
              </span>
            </label>
          </CardContent>
          <CardFooter>
            <Button type="submit" pending={award.isPending}>
              Award badge
            </Button>
          </CardFooter>
        </form>
      </Card>

      <div className="grid gap-6 xl:sticky xl:top-6">
        {selected && (
          <BadgePreview
            imageUrl={selected.image?.url512 ?? null}
            name={selected.name}
            achievementType={selected.achievementType}
            description={selected.description}
            criteriaNarrative={selected.criteriaNarrative ?? ''}
            criteriaUrl={selected.criteriaUrl ?? ''}
            tags={selected.tags}
            issuerName={issuerName}
            recipientName={form.name.trim() || 'Jordan Rivera'}
          />
        )}
        {form.sendEmail && emailPreview.data && (
          <figure className="overflow-hidden rounded-xl border bg-card">
            <figcaption className="border-b bg-muted px-4 py-2 text-xs font-semibold text-muted-foreground uppercase">
              Preview of the email
            </figcaption>
            <div className="grid gap-2 p-4 text-sm">
              <p>
                <span className="text-muted-foreground">From:</span> {emailPreview.data.email.from}
              </p>
              {emailPreview.data.email.replyTo && (
                <p>
                  <span className="text-muted-foreground">Replies go to:</span>{' '}
                  {emailPreview.data.email.replyTo}
                </p>
              )}
              <p className="font-semibold">{emailPreview.data.email.subject}</p>
              <p className="whitespace-pre-line break-words text-muted-foreground">
                {emailPreview.data.email.text}
              </p>
            </div>
          </figure>
        )}
      </div>
    </div>
  );
}

function Awarded({
  orgId,
  credential,
  onAnother,
}: {
  orgId: string;
  credential: CredentialDetails;
  onAnother: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const emailed = credential.delivery !== 'not_sent';
  return (
    <Card>
      <CardHeader>
        <CardTitle ref={heading} tabIndex={-1} className="flex items-center gap-2 outline-none">
          <CheckCircle2 className="size-5 text-ok" aria-hidden="true" />
          Awarded to {credential.recipient?.name}
        </CardTitle>
        <CardDescription>
          {credential.achievement.name} is signed and stored.{' '}
          {emailed
            ? `An email with their link is on its way to ${credential.recipient?.email}.`
            : 'No email was sent.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <a href={credential.url} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden="true" />
            Open the badge page
          </a>
        </Button>
        <Button asChild variant="outline">
          <Link
            to="/app/orgs/$orgId/credentials/$credentialId"
            params={{ orgId, credentialId: credential.id }}
          >
            See delivery status
          </Link>
        </Button>
        <Button onClick={onAnother}>Award another</Button>
      </CardContent>
    </Card>
  );
}
