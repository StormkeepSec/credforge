import type { OrgStatus } from '@credforge/contracts';
import type { CredentialVerification } from '@credforge/ob3';
import type { ReactNode } from 'react';
import { OrgStatusNotice } from '../components/org-notice';
import { ReportProblem, SitePage, websiteLabel } from '../components/site-chrome';
import { Document } from '../document';
import { formatLongDate } from '../format';

export type CredentialState = 'valid' | 'expired' | 'revoked' | 'not_yet_valid';

/** Everything the page shows, read from the signed credential (what was actually issued). */
export interface CredentialView {
  achievement: {
    url: string;
    name: string;
    description: string;
    typeLabel: string;
    criteriaNarrative: string | null;
    criteriaUrl: string | null;
    tags: string[];
    alignments: {
      targetName: string;
      targetUrl: string;
      targetFramework?: string;
      targetCode?: string;
    }[];
  };
  image: { url: string; alt: string } | null;
  ogImage: { url: string; width: number; height: number } | null;
  recipientName: string | null;
  issuer: { name: string; pageUrl: string; website: string | null; logoUrl: string | null };
  validFrom: Date;
  validUntil: Date | null;
  state: CredentialState;
  revokedAt: Date | null;
  /** `superseded`: replaced by a corrected copy. The public reason, if the issuer gave one. */
  revocation: { kind: 'revoked' | 'superseded'; publicReason: string | null } | null;
  evidence: { url?: string; name?: string; narrative?: string }[];
  downloads: { png: string; svg: string | null; json: string; certificate: string };
}

export interface OwnerView {
  visibility: 'public' | 'hidden';
  linkedInUrl: string;
  visibilityAction: string;
}

export interface CredentialPageProps {
  url: string;
  stylesheet: string;
  credential: CredentialView;
  verification: CredentialVerification;
  /** Set when the visitor holds the recipient's claim link. */
  owner: OwnerView | null;
  /** A claim link that didn't work. */
  notice: 'link_expired' | null;
  /** The issuer's website host, when the issuer proved it controls it (§6.3). */
  issuerVerifiedHost: string | null;
  /** Where "Report a problem" goes; unset hides it. */
  reportEmail?: string;
  /** The awarding organization's status: pages say when it is new, suspended or declined. */
  orgStatus: OrgStatus;
}

const STATE: Record<CredentialState, { label: string; className: string }> = {
  valid: { label: 'Valid', className: 'border-success/40 bg-success/10 text-success' },
  expired: { label: 'Expired', className: 'border-warning/40 bg-warning/10 text-warning' },
  revoked: { label: 'Revoked', className: 'border-danger/40 bg-danger/10 text-danger' },
  not_yet_valid: {
    label: 'Not valid yet',
    className: 'border-warning/40 bg-warning/10 text-warning',
  },
};

const link = 'font-semibold text-signal-strong underline underline-offset-4 hover:text-ink';
const button =
  'inline-flex items-center gap-2 rounded-full border border-ink/20 bg-white px-4 py-2 text-sm font-semibold text-ink hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-strong';
const primaryButton =
  'inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-canvas hover:bg-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-strong';

export function StatusPill({ state }: { state: CredentialState }) {
  const { label, className } = STATE[state];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-semibold ${className}`}
    >
      {label}
    </span>
  );
}

export function CheckIcon({ outcome }: { outcome: 'passed' | 'failed' | 'skipped' }) {
  const color =
    outcome === 'passed' ? 'text-success' : outcome === 'failed' ? 'text-danger' : 'text-ink-muted';
  return (
    <svg
      viewBox="0 0 20 20"
      className={`mt-0.5 size-5 shrink-0 ${color}`}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      {outcome === 'passed' && (
        <path d="M6 10.5l2.5 2.5L14 7.5" fill="none" stroke="currentColor" strokeWidth="2" />
      )}
      {outcome === 'failed' && (
        <path d="M7 7l6 6M13 7l-6 6" fill="none" stroke="currentColor" strokeWidth="2" />
      )}
      {outcome === 'skipped' && (
        <path d="M6 10h8" fill="none" stroke="currentColor" strokeWidth="2" />
      )}
    </svg>
  );
}

const CHECK_LABELS = {
  format: 'Open Badges 3.0 format',
  proof: 'Signature',
  status: 'Revocation',
  validity: 'Dates',
} as const;

const OUTCOME_WORDS = { passed: 'passed', failed: 'failed', skipped: 'not checked' } as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-t border-ink/10 py-8">
      <h2 id={id} className="text-xl font-bold tracking-tight">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * The public credential page (design plan §11.2): the badge first, then what it is, who earned
 * it and who awarded it, the separate verification checks, and downloads. The recipient (holding
 * their claim link) also sees Add to LinkedIn and can hide the page.
 */
export function CredentialPage({
  url,
  stylesheet,
  credential: c,
  verification,
  owner,
  notice,
  issuerVerifiedHost,
  reportEmail,
  orgStatus,
}: CredentialPageProps) {
  const website = c.issuer.website ? websiteLabel(c.issuer.website, issuerVerifiedHost) : null;
  const awardedTo = c.recipientName ? ` awarded to ${c.recipientName}` : '';
  return (
    <Document
      title={`${c.achievement.name}${awardedTo} · ${c.issuer.name}`}
      description={`${c.issuer.name} awarded ${c.recipientName ?? 'this badge'} ${c.achievement.name}. ${c.achievement.description}`.slice(
        0,
        300,
      )}
      url={url}
      stylesheet={stylesheet}
      alternateJson={url}
      noindex
      image={
        c.ogImage
          ? { ...c.ogImage, alt: `${c.achievement.name} badge from ${c.issuer.name}` }
          : undefined
      }
    >
      <SitePage>
        <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
          <OrgStatusNotice status={orgStatus} subject="badge" className="mb-8" />
          {notice === 'link_expired' && (
            <div role="note" className="mb-8 rounded-lg border border-warning/40 bg-warning/5 p-4">
              <p className="font-semibold">This link no longer works</p>
              <p className="mt-1 text-sm text-ink-muted">
                It has expired, or a newer one was sent. Ask {c.issuer.name} to send you a new link.
                Anyone can still see the badge below.
              </p>
            </div>
          )}
          {owner && (
            <section
              aria-labelledby="owner-heading"
              className="mb-10 rounded-2xl border border-signal-strong/30 bg-white p-5 sm:p-6"
            >
              <h2 id="owner-heading" className="text-lg font-bold">
                This is your badge
              </h2>
              <p className="mt-1 text-sm text-ink-muted">
                {owner.visibility === 'hidden'
                  ? 'Its page is hidden: only you see it, through your link. Others get “page not found”.'
                  : 'Its page is public: anyone with its address can see it. Only you see this box.'}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <a href={owner.linkedInUrl} rel="noopener noreferrer" className={primaryButton}>
                  Add to LinkedIn
                </a>
                <form method="post" action={owner.visibilityAction}>
                  <input
                    type="hidden"
                    name="visibility"
                    value={owner.visibility === 'hidden' ? 'public' : 'hidden'}
                  />
                  <button type="submit" className={button}>
                    {owner.visibility === 'hidden' ? 'Make the page public' : 'Hide the page'}
                  </button>
                </form>
              </div>
            </section>
          )}

          <div className="grid items-start gap-8 md:grid-cols-[18rem_1fr] md:gap-12">
            <div className="mx-auto w-full max-w-72">
              {c.image ? (
                <img
                  src={c.image.url}
                  alt={c.image.alt}
                  width={512}
                  height={512}
                  className="aspect-square w-full object-contain"
                />
              ) : (
                <div className="aspect-square w-full rounded-3xl bg-ink/5" />
              )}
            </div>
            <div>
              <p className="text-sm font-bold tracking-[0.15em] text-signal-strong uppercase">
                {c.achievement.typeLabel}
              </p>
              <h1 className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
                {c.achievement.name}
              </h1>
              <p className="mt-4 text-lg leading-relaxed text-ink-muted">
                Awarded{' '}
                {c.recipientName && (
                  <>
                    to <strong className="font-semibold text-ink">{c.recipientName}</strong>{' '}
                  </>
                )}
                by{' '}
                {c.issuer.logoUrl && (
                  <img
                    src={c.issuer.logoUrl}
                    alt=""
                    width={28}
                    height={28}
                    className="mr-1.5 inline-block size-7 rounded object-contain align-middle"
                  />
                )}
                <a href={c.issuer.pageUrl} className={link}>
                  {c.issuer.name}
                </a>
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
                <StatusPill state={c.state} />
                <p className="text-sm text-ink-muted">
                  {c.state === 'revoked' && c.revokedAt ? (
                    <>
                      Revoked on{' '}
                      <time dateTime={c.revokedAt.toISOString()}>
                        {formatLongDate(c.revokedAt)}
                      </time>
                    </>
                  ) : (
                    <>
                      Awarded{' '}
                      <time dateTime={c.validFrom.toISOString()}>
                        {formatLongDate(c.validFrom)}
                      </time>
                      {c.validUntil && (
                        <>
                          {' · '}
                          {c.state === 'expired' ? 'Expired' : 'Expires'}{' '}
                          <time dateTime={c.validUntil.toISOString()}>
                            {formatLongDate(c.validUntil)}
                          </time>
                        </>
                      )}
                    </>
                  )}
                </p>
              </div>
              {c.revocation && (
                <div
                  role="note"
                  className="mt-6 rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm"
                >
                  <p className="font-semibold">
                    {c.revocation.kind === 'superseded'
                      ? `${c.issuer.name} replaced this badge with a corrected copy.`
                      : `${c.issuer.name} revoked this badge.`}
                  </p>
                  {c.revocation.publicReason && (
                    <p className="mt-1 text-ink-muted">
                      Reason given by the issuer: {c.revocation.publicReason}
                    </p>
                  )}
                </div>
              )}
              <ul aria-label="Downloads" className="mt-8 flex flex-wrap gap-3">
                <li>
                  <a href={c.downloads.png} download className={button}>
                    Download badge (PNG)
                  </a>
                </li>
                {c.downloads.svg && (
                  <li>
                    <a href={c.downloads.svg} download className={button}>
                      Badge (SVG)
                    </a>
                  </li>
                )}
                <li>
                  <a href={c.downloads.json} download className={button}>
                    Credential (JSON)
                  </a>
                </li>
                <li>
                  <a href={c.downloads.certificate} className={button}>
                    Printable certificate
                  </a>
                </li>
              </ul>
              <p className="mt-3 text-sm text-ink-muted">
                The badge image carries the signed credential, so any Open Badges 3.0 tool can check
                it.
              </p>
            </div>
          </div>

          <div className="mt-12">
            <Section id="about-heading" title="About this achievement">
              <p className="leading-relaxed whitespace-pre-line">{c.achievement.description}</p>
              {(c.achievement.criteriaNarrative || c.achievement.criteriaUrl) && (
                <>
                  <h3 className="mt-6 font-bold">How it is earned</h3>
                  {c.achievement.criteriaNarrative && (
                    <p className="mt-2 leading-relaxed whitespace-pre-line text-ink-muted">
                      {c.achievement.criteriaNarrative}
                    </p>
                  )}
                  {c.achievement.criteriaUrl && (
                    <p className="mt-2">
                      <a
                        href={c.achievement.criteriaUrl}
                        rel="nofollow noopener noreferrer"
                        className={link}
                      >
                        Criteria on {hostOf(c.achievement.criteriaUrl)}
                      </a>
                    </p>
                  )}
                </>
              )}
            </Section>

            {c.achievement.tags.length > 0 && (
              <Section id="skills-heading" title="Skills">
                <ul className="flex flex-wrap gap-2">
                  {c.achievement.tags.map((tag) => (
                    <li
                      key={tag}
                      className="rounded-full border border-ink/15 bg-white px-3 py-1 text-sm"
                    >
                      {tag}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {c.achievement.alignments.length > 0 && (
              <Section id="alignments-heading" title="Aligned with">
                <ul className="grid gap-2">
                  {c.achievement.alignments.map((alignment) => (
                    <li key={alignment.targetUrl + alignment.targetName}>
                      <a
                        href={alignment.targetUrl}
                        rel="nofollow noopener noreferrer"
                        className={link}
                      >
                        {alignment.targetName}
                      </a>
                      {(alignment.targetFramework || alignment.targetCode) && (
                        <span className="text-sm text-ink-muted">
                          {' '}
                          (
                          {[alignment.targetFramework, alignment.targetCode]
                            .filter(Boolean)
                            .join(' · ')}
                          )
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {c.evidence.length > 0 && (
              <Section id="evidence-heading" title="Evidence">
                <ul className="grid gap-4">
                  {c.evidence.map((item, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: evidence has no id of its own
                    <li key={index}>
                      {item.url ? (
                        <a href={item.url} rel="nofollow noopener noreferrer" className={link}>
                          {item.name ?? hostOf(item.url)}
                        </a>
                      ) : (
                        item.name && <p className="font-semibold">{item.name}</p>
                      )}
                      {item.narrative && (
                        <p className="mt-1 whitespace-pre-line text-ink-muted">{item.narrative}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section id="verification-heading" title="Verification">
              <p className="text-ink-muted">
                Checked on this page just now, the same way any Open Badges 3.0 verifier would.
              </p>
              <ul className="mt-4 grid gap-3">
                {(Object.keys(CHECK_LABELS) as (keyof typeof CHECK_LABELS)[]).map((key) => {
                  const check = verification.checks[key];
                  return (
                    <li key={key} className="flex gap-3">
                      <CheckIcon outcome={check.outcome} />
                      <div>
                        <p className="font-semibold">
                          {CHECK_LABELS[key]}
                          <span className="sr-only">: {OUTCOME_WORDS[check.outcome]}</span>
                        </p>
                        <p className="text-sm text-ink-muted">{check.message}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Section>

            <Section id="details-heading" title="Details">
              <dl className="grid gap-5 text-sm sm:grid-cols-2">
                <div>
                  <dt className="font-semibold text-ink-muted">Issuer</dt>
                  <dd className="mt-1">
                    <a href={c.issuer.pageUrl} className={link}>
                      {c.issuer.name}
                    </a>
                    {website && (
                      <span className="text-ink-muted">
                        {' '}
                        · {website.verified ? 'website verified:' : 'website'} {website.host}
                        {website.verified ? '' : ' (self-reported)'}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink-muted">Achievement</dt>
                  <dd className="mt-1">
                    <a href={c.achievement.url} className={link}>
                      {c.achievement.name}
                    </a>
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="font-semibold text-ink-muted">Credential ID</dt>
                  <dd className="mt-1 font-mono break-all">{url}</dd>
                </div>
              </dl>
              <div className="mt-8 grid gap-2">
                <p className="text-sm text-ink-muted">Hosted on credforge.</p>
                <ReportProblem email={reportEmail} pageUrl={url} />
              </div>
            </Section>
          </div>
        </div>
      </SitePage>
    </Document>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
