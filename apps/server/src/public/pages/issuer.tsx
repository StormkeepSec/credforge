import type { OrgStatus } from '@credforge/contracts';
import { OrgStatusNotice } from '../components/org-notice';
import { ReportProblem, SitePage, websiteLabel } from '../components/site-chrome';
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
    /** The website's host when the issuer proved it controls it (§6.3). */
    verifiedHost: string | null;
  };
  /** Where "Report a problem" goes; unset hides it. */
  reportEmail?: string;
  orgStatus: OrgStatus;
  keyCount: number;
}

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
 * verifiers (content negotiation). Wording stays factual: the website is "verified" only when
 * the issuer proved it controls the domain, and "self-reported" otherwise (design plan §6.3).
 */
export function IssuerPage({
  url,
  stylesheet,
  issuer,
  orgStatus,
  keyCount,
  reportEmail,
}: IssuerPageProps) {
  const website = issuer.website ? websiteLabel(issuer.website, issuer.verifiedHost) : null;
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

          <OrgStatusNotice status={orgStatus} subject="issuer" />

          {issuer.description && (
            <p className="mt-8 text-lg leading-relaxed whitespace-pre-line text-ink-muted">
              {issuer.description}
            </p>
          )}

          <dl className="mt-10 grid gap-6 border-t border-ink/10 pt-8 sm:grid-cols-2">
            {issuer.website && website && (
              <div>
                <dt className="text-sm font-semibold text-ink-muted">
                  {website.verified ? 'Website verified' : 'Website (self-reported)'}
                </dt>
                <dd className="mt-1">
                  <a
                    href={issuer.website}
                    rel="nofollow noopener noreferrer"
                    className="font-semibold text-signal-strong underline underline-offset-4"
                  >
                    {website.host}
                  </a>
                </dd>
                <dd className="mt-1 text-sm text-ink-muted">
                  {website.verified
                    ? 'The issuer proved it controls this domain.'
                    : 'The issuer hasn’t proved it controls this domain.'}
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
          <div className="mt-12 grid gap-2">
            <p className="text-sm text-ink-muted">Hosted on credforge.</p>
            <ReportProblem email={reportEmail} pageUrl={url} />
          </div>
        </section>
      </SitePage>
    </Document>
  );
}
