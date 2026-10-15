import type { OrgStatus } from '@credforge/contracts';
import { SitePage } from '../components/site-chrome';
import { Document } from '../document';

export interface IssuerPageProps {
  url: string;
  stylesheet: string;
  issuer: {
    name: string;
    description: string | null;
    website: string | null;
    email: string | null;
    /** 512 px logo. */
    logoUrl: string | null;
  };
  orgStatus: OrgStatus;
  keyCount: number;
}

const notices: Partial<Record<OrgStatus, { title: string; body: string }>> = {
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

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '');
  return letters.join('') || '?';
}

/**
 * The human view of an issuer's permanent URL. The same URL serves the issuer profile JSON to
 * verifiers (content negotiation). Wording stays factual: the website is self-reported until
 * domain verification exists (design plan §6.3).
 */
export function IssuerPage({ url, stylesheet, issuer, orgStatus, keyCount }: IssuerPageProps) {
  const notice = notices[orgStatus];
  const websiteHost = issuer.website ? new URL(issuer.website).host : null;
  return (
    <Document
      title={`${issuer.name} · Issuer on credforge`}
      description={issuer.description ?? `${issuer.name} awards Open Badges on credforge.`}
      url={url}
      stylesheet={stylesheet}
      alternateJson={url}
    >
      <SitePage>
        <section className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
          <p className="text-sm font-bold tracking-[0.15em] text-signal-strong uppercase">Issuer</p>
          <div className="mt-4 flex items-center gap-5">
            {issuer.logoUrl ? (
              <img
                src={issuer.logoUrl}
                alt=""
                width={64}
                height={64}
                className="size-16 shrink-0 rounded-xl object-contain"
              />
            ) : (
              <div
                aria-hidden="true"
                className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-ink text-xl font-bold text-canvas"
              >
                {initials(issuer.name)}
              </div>
            )}
            <h1 className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">
              {issuer.name}
            </h1>
          </div>

          {notice && (
            <div
              role="note"
              className="mt-8 rounded-lg border border-warning/40 bg-warning/5 p-4 text-ink"
            >
              <p className="font-semibold">{notice.title}</p>
              <p className="mt-1 text-sm text-ink-muted">{notice.body}</p>
            </div>
          )}

          {issuer.description && (
            <p className="mt-8 text-lg leading-relaxed whitespace-pre-line text-ink-muted">
              {issuer.description}
            </p>
          )}

          <dl className="mt-10 grid gap-6 border-t border-ink/10 pt-8 sm:grid-cols-2">
            {issuer.website && websiteHost && (
              <div>
                <dt className="text-sm font-semibold text-ink-muted">Website (self-reported)</dt>
                <dd className="mt-1">
                  <a
                    href={issuer.website}
                    rel="nofollow noopener noreferrer"
                    className="font-semibold text-signal-strong underline underline-offset-4"
                  >
                    {websiteHost}
                  </a>
                </dd>
              </div>
            )}
            {issuer.email && (
              <div>
                <dt className="text-sm font-semibold text-ink-muted">Contact</dt>
                <dd className="mt-1">
                  <a
                    href={`mailto:${issuer.email}`}
                    className="font-semibold text-signal-strong underline underline-offset-4"
                  >
                    {issuer.email}
                  </a>
                </dd>
              </div>
            )}
            <div className="sm:col-span-2">
              <dt className="text-sm font-semibold text-ink-muted">Issuer ID</dt>
              <dd className="mt-1 font-mono text-sm break-all">{url}</dd>
              <dd className="mt-2 text-sm text-ink-muted">
                Badges from this issuer carry this ID and are signed with{' '}
                {keyCount === 1 ? 'its published key' : `one of its ${keyCount} published keys`}.
                Verifiers read the issuer profile and its keys as JSON from this same address.
              </dd>
            </div>
          </dl>
          <p className="mt-12 text-sm text-ink-muted">Hosted on credforge.</p>
        </section>
      </SitePage>
    </Document>
  );
}
