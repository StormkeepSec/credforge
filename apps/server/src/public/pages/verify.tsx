import type { VerifyCheck, VerifyResult } from '@credforge/contracts';
import { SitePage } from '../components/site-chrome';
import { Document } from '../document';
import { formatLongDate } from '../format';
import { CheckIcon } from './credential';

export interface VerifyPageProps {
  url: string;
  stylesheet: string;
  /** What the visitor entered, to show again (never the email address after a check). */
  values: { url: string; json: string };
  /** Why nothing could be checked. */
  error: string | null;
  result: VerifyResult | null;
}

const CHECK_LABELS = {
  format: 'Open Badges 3.0 format',
  proof: 'Signature',
  status: 'Revocation',
  validity: 'Dates',
  recipient: 'Recipient',
} as const;

const OUTCOME_WORDS = { passed: 'passed', failed: 'failed', skipped: 'not checked' } as const;

const field =
  'mt-2 block w-full rounded-lg border border-ink/30 bg-white px-3 py-2 text-base text-ink placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal-strong';
const primaryButton =
  'inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-canvas hover:bg-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-strong';
const link = 'font-semibold text-signal-strong underline underline-offset-4 hover:text-ink';

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function dateOf(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function CheckList({ checks }: { checks: VerifyResult['checks'] }) {
  const keys = (Object.keys(CHECK_LABELS) as (keyof typeof CHECK_LABELS)[]).filter(
    (key) => checks[key] !== undefined,
  );
  return (
    <ul className="mt-4 grid gap-4">
      {keys.map((key) => {
        const check = checks[key] as VerifyCheck;
        return (
          <li key={key} className="flex gap-3">
            <CheckIcon outcome={check.outcome} />
            <div className="min-w-0">
              <p className="font-semibold">
                {CHECK_LABELS[key]}
                <span className="sr-only">: {OUTCOME_WORDS[check.outcome]}</span>
              </p>
              <p className="text-sm break-words text-ink-muted">{check.message}</p>
              {check.details && check.details.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-sm break-words text-ink-muted">
                  {check.details.slice(0, 5).map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Result({ result }: { result: VerifyResult }) {
  const c = result.credential;
  const validFrom = dateOf(c?.validFrom ?? null);
  const validUntil = dateOf(c?.validUntil ?? null);
  const issuerHost = hostOf(c?.issuer.id ?? null);
  return (
    <section
      aria-labelledby="result-heading"
      className={`mt-8 rounded-2xl border bg-white p-5 sm:p-8 ${result.verified ? 'border-success/50' : 'border-danger/50'}`}
    >
      <h2 id="result-heading" className="text-2xl font-bold tracking-tight">
        {result.verified ? 'Every check passed' : 'Not every check passed'}
      </h2>
      <p className="mt-2 text-ink-muted">
        {result.verified
          ? 'The credential is well formed, its signature checks out with a key its issuer publishes, it isn’t revoked, and today is within its dates.'
          : 'Read each check below to see what didn’t pass.'}
      </p>
      {c && (
        <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
          {c.achievement.name && (
            <div>
              <dt className="font-semibold text-ink-muted">Achievement</dt>
              <dd className="mt-1 text-base font-semibold">{c.achievement.name}</dd>
            </div>
          )}
          {c.recipientName && (
            <div>
              <dt className="font-semibold text-ink-muted">Awarded to</dt>
              <dd className="mt-1 text-base">{c.recipientName}</dd>
            </div>
          )}
          <div>
            <dt className="font-semibold text-ink-muted">Issuer</dt>
            <dd className="mt-1 break-words">
              {c.issuer.name ?? 'Unnamed issuer'}
              {issuerHost && (
                <span className="text-ink-muted">
                  {' '}
                  · {c.issuedHere ? 'issued on this credforge site' : `identified by ${issuerHost}`}
                </span>
              )}
            </dd>
          </div>
          {validFrom && (
            <div>
              <dt className="font-semibold text-ink-muted">Dates</dt>
              <dd className="mt-1">
                Valid from{' '}
                <time dateTime={validFrom.toISOString()}>{formatLongDate(validFrom)}</time>
                {validUntil && (
                  <>
                    {' '}
                    until{' '}
                    <time dateTime={validUntil.toISOString()}>{formatLongDate(validUntil)}</time>
                  </>
                )}
              </dd>
            </div>
          )}
          {c.id && (
            <div className="sm:col-span-2">
              <dt className="font-semibold text-ink-muted">Credential ID</dt>
              <dd className="mt-1 font-mono break-all">
                {/^https:\/\//.test(c.id) ? (
                  <a href={c.id} rel="nofollow noopener noreferrer" className={link}>
                    {c.id}
                  </a>
                ) : (
                  c.id
                )}
              </dd>
            </div>
          )}
        </dl>
      )}
      <h3 className="mt-8 text-lg font-bold">Checks</h3>
      <CheckList checks={result.checks} />
      <p className="mt-6 text-sm text-ink-muted">
        Checked at <time dateTime={result.checkedAt}>{result.checkedAt.slice(0, 19)}Z</time>. These
        checks show the credential is intact and was signed with its issuer’s published key. They
        don’t tell you who the issuer is: look at the issuer’s own website for that.
      </p>
    </section>
  );
}

/**
 * The verification tool (design plan §8.5, §11.2): a credential's address, its JSON, or a baked
 * badge image, plus an optional "was it issued to this email address?" check. A plain form, so it
 * works without JavaScript.
 */
export function VerifyPage({ url, stylesheet, values, error, result }: VerifyPageProps) {
  return (
    <Document
      title="Verify an Open Badges 3.0 credential · credforge"
      description="Check an Open Badges 3.0 credential: its format, its issuer’s signature, whether it was revoked, and its dates."
      url={url}
      stylesheet={stylesheet}
    >
      <SitePage>
        <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
          <p className="text-sm font-bold tracking-[0.15em] text-signal-strong uppercase">Verify</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
            Check an Open Badges 3.0 credential
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-ink-muted">
            Give the badge’s address, paste its JSON, or upload the badge image. Each check is shown
            on its own: the format, the issuer’s signature, revocation and the dates.
          </p>

          {error && (
            <div role="alert" className="mt-8 rounded-lg border border-danger/40 bg-danger/5 p-4">
              <p className="font-semibold">Nothing was checked</p>
              <p className="mt-1 text-sm text-ink-muted">{error}</p>
            </div>
          )}

          {result && <Result result={result} />}

          <form
            method="post"
            action="/verify"
            encType="multipart/form-data"
            className="mt-10 grid gap-6"
          >
            <fieldset className="grid gap-5">
              <legend className="text-lg font-bold">What to check (one of these)</legend>
              <div>
                <label htmlFor="verify-url" className="font-semibold">
                  The credential’s address
                </label>
                <input
                  id="verify-url"
                  name="url"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="https://…"
                  defaultValue={values.url}
                  className={field}
                />
              </div>
              <div>
                <label htmlFor="verify-json" className="font-semibold">
                  Or its JSON
                </label>
                <textarea
                  id="verify-json"
                  name="json"
                  rows={5}
                  spellCheck={false}
                  defaultValue={values.json}
                  className={`${field} font-mono text-sm`}
                />
              </div>
              <div>
                <label htmlFor="verify-file" className="font-semibold">
                  Or a baked badge image
                </label>
                <p id="verify-file-hint" className="text-sm text-ink-muted">
                  A PNG or SVG badge that carries its credential, up to 4 MB.
                </p>
                <input
                  id="verify-file"
                  name="file"
                  type="file"
                  accept="image/png,image/svg+xml,.png,.svg"
                  aria-describedby="verify-file-hint"
                  className="mt-2 block w-full text-sm file:mr-4 file:rounded-full file:border file:border-ink/20 file:bg-white file:px-4 file:py-2 file:font-semibold file:text-ink"
                />
              </div>
            </fieldset>
            <div>
              <label htmlFor="verify-email" className="font-semibold">
                Email address (optional)
              </label>
              <p id="verify-email-hint" className="text-sm text-ink-muted">
                Checks whether the credential was issued to this address, using the salted hash in
                the credential. The address isn’t stored.
              </p>
              <input
                id="verify-email"
                name="email"
                type="email"
                autoComplete="off"
                aria-describedby="verify-email-hint"
                className={field}
              />
            </div>
            <div>
              <button type="submit" className={primaryButton}>
                Check
              </button>
            </div>
          </form>
        </div>
      </SitePage>
    </Document>
  );
}
