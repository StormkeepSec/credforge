import { SitePage } from '../components/site-chrome';
import { Document } from '../document';

interface TooManyRequestsPageProps {
  url: string;
  stylesheet: string;
  retryAfter: number;
}

/** A rate limit on a public page (claim links): wait, then try again. */
export function TooManyRequestsPage({ url, stylesheet, retryAfter }: TooManyRequestsPageProps) {
  return (
    <Document
      title="Too many requests · credforge"
      description="Too many requests from this network."
      url={url}
      stylesheet={stylesheet}
      noindex
    >
      <SitePage>
        <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
          <p className="text-sm font-bold tracking-[0.15em] text-signal-strong uppercase">429</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight">Too many requests</h1>
          <p className="mt-4 max-w-xl text-lg text-ink-muted">
            Too many links were opened from this network in the last minute. Wait {retryAfter}{' '}
            {retryAfter === 1 ? 'second' : 'seconds'}, then open the link again.
          </p>
        </section>
      </SitePage>
    </Document>
  );
}
