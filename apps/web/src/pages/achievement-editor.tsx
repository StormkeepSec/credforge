import {
  ACHIEVEMENT_TYPES,
  type Achievement,
  type AchievementInputBody,
  achievementInput,
  achievementTypeLabel,
} from '@credforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Award, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../components/app-shell';
import { BadgePreview } from '../components/badge-preview';
import { ConfirmButton } from '../components/confirm';
import { AchievementStatusBadge } from '../components/delivery';
import { ImagePicker, type PickedImage } from '../components/image-picker';
import { isWritable, OrgStatusBanner } from '../components/org-status';
import { AchievementReview } from '../components/review';
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
import { ApiError, del, errorMessage, patch, post, queries, upload } from '../lib/api';
import { formatDate } from '../lib/utils';

interface AlignmentForm {
  targetName: string;
  targetUrl: string;
  targetFramework: string;
  targetCode: string;
}

interface Form {
  name: string;
  description: string;
  achievementType: string;
  criteriaNarrative: string;
  criteriaUrl: string;
  /** Comma-separated. */
  tags: string;
  alignments: AlignmentForm[];
  /** Days, or empty for no expiry. */
  validForDays: string;
}

function toForm(achievement?: Achievement): Form {
  return {
    name: achievement?.name ?? '',
    description: achievement?.description ?? '',
    achievementType: achievement?.achievementType ?? 'Badge',
    criteriaNarrative: achievement?.criteriaNarrative ?? '',
    criteriaUrl: achievement?.criteriaUrl ?? '',
    tags: achievement?.tags.join(', ') ?? '',
    alignments:
      achievement?.alignments.map((alignment) => ({
        targetName: alignment.targetName,
        targetUrl: alignment.targetUrl,
        targetFramework: alignment.targetFramework ?? '',
        targetCode: alignment.targetCode ?? '',
      })) ?? [],
    validForDays: achievement?.validForDays ? String(achievement.validForDays) : '',
  };
}

const splitTags = (tags: string) =>
  tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

function toBody(form: Form): AchievementInputBody {
  const days = form.validForDays.trim();
  return {
    name: form.name,
    description: form.description,
    achievementType: form.achievementType,
    criteriaNarrative: form.criteriaNarrative,
    criteriaUrl: form.criteriaUrl,
    tags: splitTags(form.tags),
    alignments: form.alignments
      .filter((alignment) => Object.values(alignment).some((value) => value.trim()))
      .map((alignment) => ({ ...alignment })),
    validForDays: days ? Number(days) : null,
  };
}

/** Field errors keyed by path (`name`, `alignments.0.targetUrl`). */
function fieldErrors(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) errors[issue.path.map(String).join('.')] ??= issue.message;
  return errors;
}

/**
 * Create or edit an achievement, with a live preview of the recipient's page (design plan
 * §11.1). Saving makes a new revision; badges already awarded keep the version they were signed
 * with.
 */
export function AchievementEditorPage({
  orgId,
  achievementId,
  created,
}: {
  orgId: string;
  achievementId?: string;
  created?: boolean;
}) {
  const { data: org } = useQuery(queries.org(orgId));
  const issuers = useQuery(queries.issuers(orgId));
  const existing = useQuery({
    ...queries.achievement(orgId, achievementId ?? ''),
    enabled: Boolean(achievementId),
  });
  if (!org || issuers.isPending || (achievementId && existing.isPending)) return <Spinner />;
  if (achievementId && existing.error) {
    return <Alert variant="error">{errorMessage(existing.error)}</Alert>;
  }
  const achievement = existing.data;
  const canWrite = isWritable(org) && org.permissions.includes('achievement:write');

  return (
    <>
      <PageHeader
        icon={Award}
        title={achievement ? achievement.name : 'New achievement'}
        description={
          achievement ? (
            <span className="flex flex-wrap items-center gap-2">
              <AchievementStatusBadge status={achievement.status} />
              <span className="text-sm">
                Revision {achievement.revision} · awarded {achievement.awardedCount}{' '}
                {achievement.awardedCount === 1 ? 'time' : 'times'}
              </span>
            </span>
          ) : (
            'It stays a draft until you publish it.'
          )
        }
      />
      <OrgStatusBanner org={org} />
      <div className="mb-6">
        <Link
          to="/app/orgs/$orgId/achievements"
          params={{ orgId }}
          className="text-sm font-semibold text-link underline-offset-4 hover:underline"
        >
          ← All achievements
        </Link>
      </div>
      {created && achievement && (
        <Alert variant="success" className="mb-6">
          Draft saved. Publish it when you’re ready to award it.
        </Alert>
      )}
      <Editor
        key={achievement?.id ?? 'new'}
        orgId={orgId}
        achievement={achievement}
        issuerName={issuers.data?.issuers[0]?.name ?? ''}
        readOnly={!canWrite}
      />
    </>
  );
}

function Editor({
  orgId,
  achievement,
  issuerName,
  readOnly,
}: {
  orgId: string;
  achievement?: Achievement;
  issuerName: string;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState<Form>(() => toForm(achievement));
  const [image, setImage] = useState<PickedImage | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const lastAlignment = useRef<HTMLInputElement>(null);
  const [focusNewAlignment, setFocusNewAlignment] = useState(false);

  useEffect(() => {
    if (focusNewAlignment) {
      lastAlignment.current?.focus();
      setFocusNewAlignment(false);
    }
  }, [focusNewAlignment]);

  const refresh = async (id: string) => {
    await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'achievements'] });
    await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'achievement', id] });
  };

  const save = useMutation({
    mutationFn: async (body: AchievementInputBody) => {
      const saved = achievement
        ? await patch<Achievement>(`/orgs/${orgId}/achievements/${achievement.id}`, body)
        : await post<Achievement>(`/orgs/${orgId}/achievements`, body);
      let imageError: unknown = null;
      if (image) {
        try {
          await upload<Achievement>(`/orgs/${orgId}/achievements/${saved.id}/image`, image.file);
        } catch (error) {
          imageError = error;
        }
      }
      return { saved, imageError };
    },
    onSuccess: async ({ saved, imageError }) => {
      await refresh(saved.id);
      if (imageError) {
        setErrors({ image: errorMessage(imageError) });
      } else {
        setImage(null);
      }
      if (!achievement) {
        await navigate({
          to: '/app/orgs/$orgId/achievements/$achievementId',
          params: { orgId, achievementId: saved.id },
          search: { created: true },
        });
        return;
      }
      if (!imageError) setNotice('Saved. Badges you award from now on use this version.');
    },
    onError: (error) => {
      if (error instanceof ApiError) setErrors(error.fieldErrors);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    const body = toBody(form);
    const parsed = achievementInput.safeParse(body);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    save.mutate(body);
  }

  const set = (key: Exclude<keyof Form, 'alignments'>) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const setAlignment =
    (index: number, key: keyof AlignmentForm) => (event: { target: { value: string } }) =>
      setForm((current) => ({
        ...current,
        alignments: current.alignments.map((alignment, i) =>
          i === index ? { ...alignment, [key]: event.target.value } : alignment,
        ),
      }));

  const preview = (
    <BadgePreview
      imageUrl={image?.dataUrl ?? achievement?.image?.url512 ?? null}
      name={form.name}
      achievementType={form.achievementType}
      description={form.description}
      criteriaNarrative={form.criteriaNarrative}
      criteriaUrl={form.criteriaUrl}
      tags={splitTags(form.tags)}
      issuerName={issuerName}
      recipientName="Jordan Rivera"
    />
  );

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[1fr_20rem]">
      <div className="grid gap-6">
        <Card>
          <form onSubmit={onSubmit} noValidate>
            <CardHeader>
              <CardTitle>Details</CardTitle>
              <CardDescription>
                Signed into every badge you award. Changes apply to badges awarded from now on.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              {save.isError && Object.keys(errors).length === 0 && (
                <Alert variant="error">{errorMessage(save.error)}</Alert>
              )}
              {notice && <Alert variant="success">{notice}</Alert>}
              <ImagePicker
                label="Badge image"
                description="PNG, SVG, JPEG or WebP, up to 2 MB. Square, at least 400×400 px, works best; transparent backgrounds are fine."
                currentUrl={achievement?.image?.url512 ?? null}
                picked={image}
                onPick={setImage}
                error={errors.image}
                readOnly={readOnly}
                alt={achievement?.image || image ? `${form.name || 'Badge'} image` : 'No image yet'}
              />
              <Field label="Name" error={errors.name}>
                {(props) => (
                  <Input
                    {...props}
                    value={form.name}
                    onChange={set('name')}
                    readOnly={readOnly}
                    placeholder="Intro to Network Defense"
                  />
                )}
              </Field>
              <Field
                label="Type"
                description="How Open Badges describes it to other systems."
                error={errors.achievementType}
              >
                {(props) =>
                  readOnly ? (
                    <Input {...props} value={achievementTypeLabel(form.achievementType)} readOnly />
                  ) : (
                    <Select
                      {...props}
                      value={form.achievementType}
                      onChange={set('achievementType')}
                    >
                      {ACHIEVEMENT_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {achievementTypeLabel(type)}
                        </option>
                      ))}
                    </Select>
                  )
                }
              </Field>
              <Field label="Description" error={errors.description}>
                {(props) => (
                  <Textarea
                    {...props}
                    value={form.description}
                    onChange={set('description')}
                    readOnly={readOnly}
                  />
                )}
              </Field>
              <Field
                label="How it is earned"
                description="What the recipient did. Markdown is allowed."
                error={errors.criteriaNarrative}
              >
                {(props) => (
                  <Textarea
                    {...props}
                    value={form.criteriaNarrative}
                    onChange={set('criteriaNarrative')}
                    readOnly={readOnly}
                  />
                )}
              </Field>
              <Field
                label="Criteria page (optional)"
                description="A web page that explains the criteria."
                error={errors.criteriaUrl}
              >
                {(props) => (
                  <Input
                    {...props}
                    type="url"
                    placeholder="https://example.org/badges/network-defense"
                    value={form.criteriaUrl}
                    onChange={set('criteriaUrl')}
                    readOnly={readOnly}
                  />
                )}
              </Field>
              <Field
                label="Skills (optional)"
                description="Separate them with commas, e.g. networking, security."
                error={
                  errors.tags ??
                  Object.entries(errors).find(([key]) => key.startsWith('tags.'))?.[1]
                }
              >
                {(props) => (
                  <Input {...props} value={form.tags} onChange={set('tags')} readOnly={readOnly} />
                )}
              </Field>
              <Field
                label="Expires after (days, optional)"
                description="Leave it empty if badges don’t expire. You can still set a date when you award one."
                error={errors.validForDays}
              >
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={form.validForDays}
                    onChange={set('validForDays')}
                    readOnly={readOnly}
                    className="max-w-40"
                  />
                )}
              </Field>

              <fieldset className="grid gap-4">
                {/* Floated, so the legend is laid out as the grid's first row instead of on the border. */}
                <legend className="float-left w-full text-sm font-semibold">
                  Alignments (optional)
                </legend>
                <p className="-mt-2 text-sm text-muted-foreground">
                  Frameworks, standards or competencies this achievement maps to.
                </p>
                {form.alignments.map((alignment, index) => (
                  <fieldset
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved
                    key={index}
                    className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2"
                  >
                    <legend className="px-1 text-sm font-semibold">Alignment {index + 1}</legend>
                    <Field label="Name" error={errors[`alignments.${index}.targetName`]}>
                      {(props) => (
                        <Input
                          {...props}
                          ref={index === form.alignments.length - 1 ? lastAlignment : undefined}
                          value={alignment.targetName}
                          onChange={setAlignment(index, 'targetName')}
                          readOnly={readOnly}
                        />
                      )}
                    </Field>
                    <Field label="Web address" error={errors[`alignments.${index}.targetUrl`]}>
                      {(props) => (
                        <Input
                          {...props}
                          type="url"
                          value={alignment.targetUrl}
                          onChange={setAlignment(index, 'targetUrl')}
                          readOnly={readOnly}
                        />
                      )}
                    </Field>
                    <Field
                      label="Framework (optional)"
                      error={errors[`alignments.${index}.targetFramework`]}
                    >
                      {(props) => (
                        <Input
                          {...props}
                          value={alignment.targetFramework}
                          onChange={setAlignment(index, 'targetFramework')}
                          readOnly={readOnly}
                        />
                      )}
                    </Field>
                    <Field label="Code (optional)" error={errors[`alignments.${index}.targetCode`]}>
                      {(props) => (
                        <Input
                          {...props}
                          value={alignment.targetCode}
                          onChange={setAlignment(index, 'targetCode')}
                          readOnly={readOnly}
                        />
                      )}
                    </Field>
                    {!readOnly && (
                      <div className="sm:col-span-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setForm((current) => ({
                              ...current,
                              alignments: current.alignments.filter((_, i) => i !== index),
                            }))
                          }
                        >
                          <Trash2 aria-hidden="true" />
                          Remove alignment {index + 1}
                        </Button>
                      </div>
                    )}
                  </fieldset>
                ))}
                {!readOnly && form.alignments.length < 20 && (
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setForm((current) => ({
                          ...current,
                          alignments: [
                            ...current.alignments,
                            { targetName: '', targetUrl: '', targetFramework: '', targetCode: '' },
                          ],
                        }));
                        setFocusNewAlignment(true);
                      }}
                    >
                      <Plus aria-hidden="true" />
                      Add alignment
                    </Button>
                  </div>
                )}
              </fieldset>
            </CardContent>
            {!readOnly && (
              <CardFooter>
                <Button type="submit" pending={save.isPending}>
                  {achievement ? 'Save changes' : 'Save draft'}
                </Button>
              </CardFooter>
            )}
          </form>
        </Card>
        {achievement && <StatusCard orgId={orgId} achievement={achievement} readOnly={readOnly} />}
      </div>
      <div className="xl:sticky xl:top-6">{preview}</div>
    </div>
  );
}

function StatusCard({
  orgId,
  achievement,
  readOnly,
}: {
  orgId: string;
  achievement: Achievement;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const action = useMutation({
    mutationFn: (name: 'publish' | 'archive' | 'restore') =>
      post<Achievement>(`/orgs/${orgId}/achievements/${achievement.id}/${name}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'achievements'] });
      await queryClient.invalidateQueries({
        queryKey: ['org', orgId, 'achievement', achievement.id],
      });
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/orgs/${orgId}/achievements/${achievement.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'achievements'] });
      await navigate({ to: '/app/orgs/$orgId/achievements', params: { orgId } });
    },
  });
  const error = action.error ?? remove.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Status</CardTitle>
        <CardDescription>
          {achievement.status === 'draft' &&
            'A draft can’t be awarded, and its page isn’t public yet.'}
          {achievement.status === 'active' &&
            `Published${achievement.publishedAt ? ` on ${formatDate(achievement.publishedAt)}` : ''}: you can award it, and its page is public.`}
          {achievement.status === 'archived' &&
            'Archived: it can’t be awarded. Its page stays up, and badges already awarded are not affected.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <AchievementReview achievement={achievement} />
        {error && <Alert variant="error">{errorMessage(error)}</Alert>}
        {achievement.status === 'draft' && !achievement.image && (
          <p className="text-sm text-muted-foreground">Add a badge image before publishing.</p>
        )}
        {achievement.status !== 'draft' && (
          <p className="text-sm">
            <a
              href={achievement.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-link underline-offset-4 hover:underline"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              Open the public page
            </a>
          </p>
        )}
      </CardContent>
      {!readOnly && (
        <CardFooter>
          {achievement.status === 'draft' && (
            <>
              <Button
                onClick={() => action.mutate('publish')}
                pending={action.isPending}
                disabled={!achievement.image}
              >
                Publish
              </Button>
              <ConfirmButton
                variant="outline"
                confirmLabel="Delete draft"
                question="Delete this draft for good?"
                pending={remove.isPending}
                onConfirm={() => remove.mutate()}
              >
                Delete draft
              </ConfirmButton>
            </>
          )}
          {achievement.status === 'active' && (
            <>
              <Button asChild>
                <Link
                  to="/app/orgs/$orgId/award"
                  params={{ orgId }}
                  search={{ achievementId: achievement.id }}
                >
                  Award it
                </Link>
              </Button>
              <ConfirmButton
                variant="outline"
                confirmLabel="Archive"
                question="Stop awarding it?"
                pending={action.isPending}
                onConfirm={() => action.mutate('archive')}
              >
                Archive
              </ConfirmButton>
            </>
          )}
          {achievement.status === 'archived' && !achievement.removed && (
            <Button
              variant="outline"
              onClick={() => action.mutate('restore')}
              pending={action.isPending}
            >
              Restore
            </Button>
          )}
        </CardFooter>
      )}
    </Card>
  );
}
