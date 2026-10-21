import { REPORT_CATEGORIES, REPORT_CATEGORY_LABELS } from '@credforge/contracts';

export type ReportField = 'category' | 'details' | 'email';

export interface ReportFormProps {
  /** `/report/{type}/{id}`. */
  action: string;
  /** Signed when the form was rendered (moderation/reports.ts). */
  token: string;
  /** Makes field ids unique when the form is part of another page. */
  idPrefix?: string;
  values?: Partial<Record<ReportField, string>>;
  errors?: Partial<Record<ReportField, string>>;
  /** The instance's abuse address (ABUSE_EMAIL), offered as another way to reach it. */
  abuseEmail?: string;
  /** The site's host, as reports go to the people who run it. */
  siteName: string;
}

const field =
  'mt-2 block w-full rounded-lg border border-ink/30 bg-white px-3 py-2 text-base text-ink placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal-strong';
const button =
  'inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-canvas hover:bg-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-strong';
const error = 'mt-1 text-sm font-semibold text-danger';

/**
 * The "Report a problem" form (design plan §6.5): a category, what is wrong, and an address for a
 * reply, all but the category optional. A plain form post, so it works without JavaScript. The
 * hidden `website` field is a trap for bots: people never see it.
 */
export function ReportForm({
  action,
  token,
  idPrefix = 'report',
  values = {},
  errors = {},
  abuseEmail,
  siteName,
}: ReportFormProps) {
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <form method="post" action={action} className="grid gap-6" noValidate>
      <input type="hidden" name="token" value={token} />
      <div hidden>
        <label>
          Leave this empty
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <fieldset
        className="grid gap-2"
        aria-describedby={errors.category ? id('category-error') : undefined}
      >
        <legend className="font-semibold">What is wrong?</legend>
        {errors.category && (
          <p id={id('category-error')} className={error}>
            {errors.category}
          </p>
        )}
        {REPORT_CATEGORIES.map((category) => (
          <label key={category} className="flex items-start gap-3">
            <input
              type="radio"
              name="category"
              value={category}
              defaultChecked={values.category === category}
              required
              className="mt-1 size-4 shrink-0 accent-ink"
            />
            <span>{REPORT_CATEGORY_LABELS[category]}</span>
          </label>
        ))}
        <p className="mt-1 text-sm text-ink-muted">
          A child-safety report hides the page’s images at once, until it has been looked at. If a
          child is in danger right now, call your local emergency number.
        </p>
      </fieldset>
      <div>
        <label htmlFor={id('details')} className="font-semibold">
          What should be looked at? (optional)
        </label>
        <textarea
          id={id('details')}
          name="details"
          rows={4}
          maxLength={2000}
          defaultValue={values.details}
          aria-describedby={errors.details ? id('details-error') : undefined}
          className={field}
        />
        {errors.details && (
          <p id={id('details-error')} className={error}>
            {errors.details}
          </p>
        )}
      </div>
      <div>
        <label htmlFor={id('email')} className="font-semibold">
          Your email address, if you’d like an answer (optional)
        </label>
        <input
          id={id('email')}
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={values.email}
          aria-describedby={errors.email ? id('email-error') : id('email-hint')}
          className={field}
        />
        {errors.email ? (
          <p id={id('email-error')} className={error}>
            {errors.email}
          </p>
        ) : (
          <p id={id('email-hint')} className="mt-1 text-sm text-ink-muted">
            Only the people who run {siteName} see it, never the organization you report.
          </p>
        )}
      </div>
      <div className="grid gap-3">
        <div>
          <button type="submit" className={button}>
            Send report
          </button>
        </div>
        <p className="text-sm text-ink-muted">
          Reports go to the people who run {siteName}.
          {abuseEmail && (
            <>
              {' '}
              You can also email{' '}
              <a
                href={`mailto:${abuseEmail}`}
                className="font-semibold text-signal-strong underline underline-offset-4"
              >
                {abuseEmail}
              </a>
              .
            </>
          )}
        </p>
      </div>
    </form>
  );
}

/**
 * The form at the foot of a public badge, achievement or issuer page, folded away until someone
 * opens it ("Report a problem").
 */
export function ReportProblem(props: ReportFormProps) {
  return (
    <details className="group text-sm">
      <summary className="cursor-pointer font-semibold text-signal-strong underline underline-offset-4 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-strong">
        Report a problem
      </summary>
      <div className="mt-4 max-w-xl rounded-lg border border-ink/15 bg-white p-4 text-base sm:p-6">
        <p className="mb-6 text-sm text-ink-muted">
          Offensive or illegal content, impersonation, phishing, or a badge that shouldn’t be here?
          Tell the people who run this site.
        </p>
        <ReportForm {...props} />
      </div>
    </details>
  );
}
