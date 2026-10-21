import type { OrgStatus } from '@credforge/contracts';
import { OrgStatusNotice } from '../components/org-notice';
import { type ReportFormProps, ReportProblem } from '../components/report-form';
import { ReviewNotice } from '../components/review-notice';
import { SitePage } from '../components/site-chrome';
import { Document } from '../document';

export interface AchievementPageProps {
  url: string;
  stylesheet: string;
  /** The "Report a problem" form at the foot of the page. */
  report: ReportFormProps;
  /** The awarding organization's status (new, suspended or declined get a notice). */
  orgStatus: OrgStatus;
  achievement: {
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
    archived: boolean;
    /**
     * Waiting for review (design plan §6.5): `new` when nothing was cleared yet (the details are
     * left out), `update` when the page shows the version cleared last.
     */
    review: 'new' | 'update' | null;
  };
  image: { url: string; alt: string } | null;
  ogImage: { url: string; width: number; height: number } | null;
  issuer: { name: string; pageUrl: string };
}

const link = 'font-semibold text-signal-strong underline underline-offset-4 hover:text-ink';

/**
 * The achievement's permanent URL as a page (design plan §9): what it is and how it is earned,
 * as currently defined. Each credential embeds the version it was issued with.
 */
export function AchievementPage({
  url,
  stylesheet,
  achievement: a,
  image,
  ogImage,
  issuer,
  report,
  orgStatus,
}: AchievementPageProps) {
  return (
    <Document
      title={`${a.name} · ${issuer.name}`}
      description={a.description.slice(0, 300)}
      url={url}
      stylesheet={stylesheet}
      alternateJson={url}
      image={ogImage ? { ...ogImage, alt: `${a.name} badge from ${issuer.name}` } : undefined}
    >
      <SitePage>
        <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
          <OrgStatusNotice status={orgStatus} subject="badge" className="mb-8" />
          {a.review && <ReviewNotice subject="achievement" state={a.review} className="mb-8" />}
          {a.archived && (
            <div role="note" className="mb-8 rounded-lg border border-warning/40 bg-warning/5 p-4">
              <p className="font-semibold">No longer awarded</p>
              <p className="mt-1 text-sm text-ink-muted">
                {issuer.name} has stopped awarding this achievement. Badges it already awarded are
                not affected.
              </p>
            </div>
          )}
          <div className="grid items-start gap-8 md:grid-cols-[16rem_1fr] md:gap-12">
            <div className="mx-auto w-full max-w-64">
              {image ? (
                <img
                  src={image.url}
                  alt={image.alt}
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
                {a.typeLabel}
              </p>
              <h1 className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
                {a.name}
              </h1>
              <p className="mt-4 text-lg text-ink-muted">
                Awarded by{' '}
                <a href={issuer.pageUrl} className={link}>
                  {issuer.name}
                </a>
              </p>
              <p className="mt-6 leading-relaxed whitespace-pre-line">{a.description}</p>
            </div>
          </div>

          {(a.criteriaNarrative || a.criteriaUrl) && (
            <section
              aria-labelledby="criteria-heading"
              className="mt-12 border-t border-ink/10 pt-8"
            >
              <h2 id="criteria-heading" className="text-xl font-bold tracking-tight">
                How it is earned
              </h2>
              {a.criteriaNarrative && (
                <p className="mt-4 leading-relaxed whitespace-pre-line text-ink-muted">
                  {a.criteriaNarrative}
                </p>
              )}
              {a.criteriaUrl && (
                <p className="mt-3">
                  <a href={a.criteriaUrl} rel="nofollow noopener noreferrer" className={link}>
                    Criteria on {new URL(a.criteriaUrl).host}
                  </a>
                </p>
              )}
            </section>
          )}

          {a.tags.length > 0 && (
            <section aria-labelledby="skills-heading" className="mt-8 border-t border-ink/10 pt-8">
              <h2 id="skills-heading" className="text-xl font-bold tracking-tight">
                Skills
              </h2>
              <ul className="mt-4 flex flex-wrap gap-2">
                {a.tags.map((tag) => (
                  <li
                    key={tag}
                    className="rounded-full border border-ink/15 bg-white px-3 py-1 text-sm"
                  >
                    {tag}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {a.alignments.length > 0 && (
            <section
              aria-labelledby="alignments-heading"
              className="mt-8 border-t border-ink/10 pt-8"
            >
              <h2 id="alignments-heading" className="text-xl font-bold tracking-tight">
                Aligned with
              </h2>
              <ul className="mt-4 grid gap-2">
                {a.alignments.map((alignment) => (
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
            </section>
          )}

          <section
            aria-labelledby="id-heading"
            className="mt-8 border-t border-ink/10 pt-8 text-sm"
          >
            <h2 id="id-heading" className="font-semibold text-ink-muted">
              Achievement ID
            </h2>
            <p className="mt-1 font-mono break-all">{url}</p>
            <div className="mt-8 grid gap-2">
              <p className="text-ink-muted">Hosted on credforge.</p>
              <ReportProblem {...report} />
            </div>
          </section>
        </div>
      </SitePage>
    </Document>
  );
}
