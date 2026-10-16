import {
  type DomainCheckResult,
  type DomainVerification,
  type Issuer,
  type IssuerInputBody,
  issuerInput,
} from '@credforge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Copy, ExternalLink, KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { PageHeader } from '../components/app-shell';
import { ConfirmButton } from '../components/confirm';
import { ImagePicker, type PickedImage } from '../components/image-picker';
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
import { Alert, Badge, Spinner } from '../components/ui/feedback';
import { Field, Input, Textarea } from '../components/ui/input';
import { ApiError, del, errorMessage, patch, post, queries, upload } from '../lib/api';
import { formatDate } from '../lib/utils';

type Form = Required<{ [K in keyof IssuerInputBody]: string }>;

function toForm(issuer?: Issuer): Form {
  return {
    name: issuer?.name ?? '',
    url: issuer?.website ?? '',
    email: issuer?.email ?? '',
    description: issuer?.description ?? '',
  };
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        <Copy aria-hidden="true" />
        {copied ? 'Copied' : label}
      </Button>
      <span role="status" className="sr-only">
        {copied ? 'Copied to the clipboard' : ''}
      </span>
    </>
  );
}

function IssuerForm({
  orgId,
  issuer,
  readOnly,
}: {
  orgId: string;
  issuer?: Issuer;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form>(() => toForm(issuer));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: IssuerInputBody) =>
      issuer
        ? patch<Issuer>(`/orgs/${orgId}/issuers/${issuer.id}`, body)
        : post<Issuer>(`/orgs/${orgId}/issuers`, body),
    onSuccess: async (result) => {
      setForm(toForm(result));
      setNotice(issuer ? 'Saved.' : 'Issuer profile created, with a new signing key.');
      await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'issuers'] });
    },
    onError: (error) => {
      if (error instanceof ApiError) setErrors(error.fieldErrors);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    const parsed = issuerInput.safeParse(form);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    save.mutate(form);
  }

  const set = (key: keyof Form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate>
        <CardHeader>
          <CardTitle>{issuer ? 'Profile' : 'Create your issuer profile'}</CardTitle>
          <CardDescription>
            Shown on every badge you award and on your public issuer page. Changes apply to badges
            awarded from now on; badges already awarded keep the details they were signed with.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          {save.isError && Object.keys(errors).length === 0 && (
            <Alert variant="error">{errorMessage(save.error)}</Alert>
          )}
          {notice && <Alert variant="success">{notice}</Alert>}
          <Field
            label="Issuer name"
            description="Usually your organization’s name."
            error={errors.name}
          >
            {(props) => (
              <Input {...props} value={form.name} onChange={set('name')} readOnly={readOnly} />
            )}
          </Field>
          <Field
            label="Website"
            description="Shown as self-reported until you verify the domain."
            error={errors.url}
          >
            {(props) => (
              <Input
                {...props}
                type="url"
                placeholder="https://example.org"
                value={form.url}
                onChange={set('url')}
                readOnly={readOnly}
              />
            )}
          </Field>
          <Field
            label="Contact email"
            description="Public. Recipients can write here with questions."
            error={errors.email}
          >
            {(props) => (
              <Input
                {...props}
                type="email"
                placeholder="badges@example.org"
                value={form.email}
                onChange={set('email')}
                readOnly={readOnly}
              />
            )}
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
        </CardContent>
        {!readOnly && (
          <CardFooter>
            <Button type="submit" pending={save.isPending}>
              {issuer ? 'Save changes' : 'Create issuer profile'}
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}

function LogoCard({
  orgId,
  issuer,
  readOnly,
}: {
  orgId: string;
  issuer: Issuer;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<PickedImage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const done = async (message: string) => {
    setPicked(null);
    setNotice(message);
    await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'issuers'] });
  };
  const save = useMutation({
    mutationFn: (file: File) => upload<Issuer>(`/orgs/${orgId}/issuers/${issuer.id}/logo`, file),
    onSuccess: () => done('Logo saved.'),
  });
  const remove = useMutation({
    mutationFn: () => del(`/orgs/${orgId}/issuers/${issuer.id}/logo`),
    onSuccess: () => done('Logo removed.'),
  });
  const error = save.error ?? remove.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Logo</CardTitle>
        <CardDescription>
          Shown on your issuer page and certificates, and included in the badges you award from now
          on. Badges already awarded keep the logo they were signed with.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && <Alert variant="error">{errorMessage(error)}</Alert>}
        {notice && <Alert variant="success">{notice}</Alert>}
        <ImagePicker
          label="Logo image"
          description="PNG, SVG, JPEG or WebP, up to 2 MB. A square logo works best."
          currentUrl={issuer.logo?.url512 ?? null}
          picked={picked}
          onPick={(image) => {
            setNotice(null);
            setPicked(image);
          }}
          readOnly={readOnly}
          alt={issuer.logo || picked ? `${issuer.name} logo` : 'No logo yet'}
        />
      </CardContent>
      {!readOnly && (
        <CardFooter>
          <Button
            onClick={() => picked && save.mutate(picked.file)}
            disabled={!picked}
            pending={save.isPending}
          >
            Save logo
          </Button>
          {issuer.logo && (
            <ConfirmButton
              variant="outline"
              confirmLabel="Remove"
              question="Remove the logo?"
              pending={remove.isPending}
              onConfirm={() => remove.mutate()}
            >
              Remove logo
            </ConfirmButton>
          )}
        </CardFooter>
      )}
    </Card>
  );
}

function IdentityCard({ issuer }: { issuer: Issuer }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-5 text-link" aria-hidden="true" />
          Issuer ID and signing key
        </CardTitle>
        <CardDescription>
          Every badge carries this ID and is signed with this key. Verifiers fetch your public key
          from the ID, so the address never changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 text-sm">
        <div className="grid gap-2">
          <p className="font-semibold">Issuer ID</p>
          <p className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">{issuer.url}</p>
          <div className="flex flex-wrap gap-2">
            <CopyButton value={issuer.url} label="Copy ID" />
            <Button asChild variant="outline" size="sm">
              <a href={issuer.url} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden="true" />
                Open public page
              </a>
            </Button>
          </div>
        </div>
        {issuer.keys.map((key) => (
          <div key={key.id} className="grid gap-1">
            <p className="flex items-center gap-2 font-semibold">
              {key.algorithm} public key
              <Badge variant={key.status === 'active' ? 'success' : 'neutral'}>{key.status}</Badge>
            </p>
            <p className="font-mono text-xs break-all text-muted-foreground">
              {key.publicKeyMultibase}
            </p>
            <p className="text-muted-foreground">
              Created {formatDate(key.createdAt)}. The private key is encrypted on the server and
              never leaves it.
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Domain verification (design plan §6.3): a DNS TXT record or a file on the website proves the
 * issuer controls it. Public pages say "Website verified" only then; otherwise "self-reported".
 */
function DomainCard({
  orgId,
  issuer,
  readOnly,
}: {
  orgId: string;
  issuer: Issuer;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const domain = issuer.domain;
  const instructions = useMutation({
    mutationFn: () =>
      post<DomainVerification>(`/orgs/${orgId}/issuers/${issuer.id}/domain-verification`),
  });
  const check = useMutation({
    mutationFn: () =>
      post<DomainCheckResult>(`/orgs/${orgId}/issuers/${issuer.id}/domain-verification/check`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['org', orgId, 'issuers'] }),
  });
  const details = check.data?.domain ?? instructions.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Website verification</CardTitle>
        <CardDescription>
          Prove that your organization controls its website’s domain. Your badge and issuer pages
          then say “Website verified” instead of “self-reported”, and verified organizations are
          easier to approve.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {!domain ? (
          <Alert variant="info" live={false}>
            Add your website (a domain name, such as https://example.org) to the profile first.
          </Alert>
        ) : domain.verifiedAt ? (
          <Alert variant="success" live={false} title={`Verified: ${domain.host}`}>
            Proven by {domain.method === 'dns' ? 'a DNS record' : 'a file on the website'} on{' '}
            {formatDate(domain.verifiedAt)}. credforge checks it again every day; keep the record or
            file in place.
          </Alert>
        ) : (
          <p>
            <span className="font-semibold">{domain.host}</span> is shown as self-reported.
          </p>
        )}

        {domain && !readOnly && !details && (
          <Button
            variant="outline"
            className="justify-self-start"
            pending={instructions.isPending}
            onClick={() => instructions.mutate()}
          >
            {domain.verifiedAt ? 'Show the record' : 'Verify this domain'}
          </Button>
        )}
        {instructions.isError && <Alert variant="error">{errorMessage(instructions.error)}</Alert>}

        {details && (
          <div className="grid gap-4">
            <p>Publish one of these, then check:</p>
            <div className="grid gap-2 rounded-md border p-4">
              <p className="font-semibold">A DNS TXT record</p>
              <dl className="grid gap-2 sm:grid-cols-[6rem_1fr]">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="font-mono break-all">{details.dnsName}</dd>
                <dt className="text-muted-foreground">Value</dt>
                <dd className="font-mono break-all">{details.value}</dd>
              </dl>
              <div className="flex flex-wrap gap-2">
                <CopyButton value={details.value} label="Copy value" />
              </div>
            </div>
            <div className="grid gap-2 rounded-md border p-4">
              <p className="font-semibold">Or a file on your website</p>
              <p className="text-muted-foreground">
                Serve this text at the address below over HTTPS, without redirects.
              </p>
              <p className="font-mono break-all">{details.fileUrl}</p>
              <p className="font-mono break-all">{details.value}</p>
            </div>
            {!readOnly && (
              <Button
                className="justify-self-start"
                pending={check.isPending}
                onClick={() => check.mutate()}
              >
                Check now
              </Button>
            )}
          </div>
        )}
        {check.isError && <Alert variant="error">{errorMessage(check.error)}</Alert>}
        {check.data && (
          <Alert
            variant={check.data.verified ? 'success' : 'warning'}
            title={check.data.verified ? 'Domain verified' : 'Not verified yet'}
          >
            <ul className="grid gap-1">
              {check.data.findings.map((finding) => (
                <li key={finding.method}>{finding.detail}</li>
              ))}
            </ul>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

/** The org's issuer profile (the OB `Profile`): create, edit, and see its id and key. */
export function OrgIssuerPage({ orgId }: { orgId: string }) {
  const { data: org } = useQuery(queries.org(orgId));
  const { data, isPending } = useQuery(queries.issuers(orgId));
  if (!org || isPending) return <Spinner />;

  // The issuer app shows one issuer per organization; the API allows several (design plan §3).
  const issuer = data?.issuers[0];
  const canWrite =
    isWritable(org) && org.permissions.includes(issuer ? 'issuer:update' : 'issuer:create');

  return (
    <>
      <PageHeader
        icon={BadgeCheck}
        title="Issuer profile"
        description="Who your badges say they’re from."
      />
      <OrgStatusBanner org={org} />
      <div className="grid gap-6">
        {!issuer && !canWrite ? (
          <Alert variant="info">This organization hasn’t set up its issuer profile yet.</Alert>
        ) : (
          <IssuerForm key={orgId} orgId={orgId} issuer={issuer} readOnly={!canWrite} />
        )}
        {issuer && <LogoCard orgId={orgId} issuer={issuer} readOnly={!canWrite} />}
        {issuer && <DomainCard orgId={orgId} issuer={issuer} readOnly={!canWrite} />}
        {issuer && <IdentityCard issuer={issuer} />}
      </div>
    </>
  );
}
