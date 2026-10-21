import { type ReportField, ReportForm, type ReportFormProps } from '../components/report-form';
import { SitePage } from '../components/site-chrome';
import { Document } from '../document';

export interface ReportPageProps {
  url: string;
  stylesheet: string;
  /** What is reported, as its page names it: "the Intro to Network Defense badge". */
  targetName: string;
  targetUrl: string;
  form: ReportFormProps;
  /** The report was sent (after the redirect). */
  sent: boolean;
  /** A problem with the whole form (expired, too many reports). */
  formError?: string;
  errors?: Partial<Record<ReportField, string>>;
}

/**
 * `/report/{type}/{id}` (design plan §6.5): the report form on a page of its own. Public pages
 * carry the same form folded away; this page is where it lands with an error, and says thank you.
 */
export function ReportPage({
  url,
  stylesheet,
  targetName,
  targetUrl,
  form,
  sent,
  formError,
  errors,
}: ReportPageProps) {
  const hasErrors = Boolean(formError) || Object.keys(errors ?? {}).length > 0;
  return (
    <Document
      title={`${sent ? 'Report sent' : 'Report a problem'} · credforge`}
      description="Report offensive or illegal content, impersonation or phishing to the people who run this site."
      url={url}
      stylesheet={stylesheet}
      noindex
    >
      <SitePage>
        <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
          <p className="text-sm font-bold tracking-[0.15em] text-signal-strong uppercase">Report</p>
          {sent ? (
            <>
              <h1 className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
                Thank you, your report was sent
              </h1>
              <p className="mt-4 text-lg leading-relaxed text-ink-muted">
                The people who run this site will look at {targetName}. If you gave your email
                address, they may write to you.
              </p>
              <p className="mt-8">
                <a
                  href={targetUrl}
                  className="font-semibold text-signal-strong underline underline-offset-4 hover:text-ink"
                >
                  Back to the page
                </a>
              </p>
            </>
          ) : (
            <>
              <h1 className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
                Report a problem
              </h1>
              <p className="mt-4 text-lg leading-relaxed text-ink-muted">
                About{' '}
                <a
                  href={targetUrl}
                  className="font-semibold text-signal-strong underline underline-offset-4 hover:text-ink"
                >
                  {targetName}
                </a>
                : offensive or illegal content, impersonation, phishing, or a badge that shouldn’t
                be here.
              </p>
              {hasErrors && (
                <div
                  role="alert"
                  className="mt-8 rounded-lg border border-danger/40 bg-danger/5 p-4"
                >
                  <p className="font-semibold">The report wasn’t sent</p>
                  <p className="mt-1 text-sm text-ink-muted">
                    {formError ?? 'Check the highlighted fields and send it again.'}
                  </p>
                </div>
              )}
              <div className="mt-10">
                <ReportForm {...form} errors={errors} />
              </div>
            </>
          )}
        </div>
      </SitePage>
    </Document>
  );
}
