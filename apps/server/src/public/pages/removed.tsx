import { SitePage } from '../components/site-chrome';
import { Document } from '../document';

interface RemovedAchievementPageProps {
  url: string;
  stylesheet: string;
  issuer: { name: string; pageUrl: string };
}

/**
 * An achievement a platform admin unpublished (design plan §6.5): 410 Gone, naming nothing of
 * what was removed. Badges awarded for it still check; their pages leave its details out.
 */
export function RemovedAchievementPage({ url, stylesheet, issuer }: RemovedAchievementPageProps) {
  return (
    <Document
      title="Achievement removed · credforge"
      description="The people who run this site removed this achievement."
      url={url}
      stylesheet={stylesheet}
      noindex
    >
      <SitePage>
        <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
          <p className="text-sm font-bold tracking-[0.15em] text-signal-strong uppercase">410</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight">This achievement was removed</h1>
          <p className="mt-4 max-w-xl text-lg text-ink-muted">
            The people who run this credforge site removed an achievement of{' '}
            <a
              href={issuer.pageUrl}
              className="font-semibold text-signal-strong underline underline-offset-4"
            >
              {issuer.name}
            </a>
            .
          </p>
          <p className="mt-4 max-w-xl text-ink-muted">
            Badges awarded for it can still be checked, but their pages no longer show its details.
          </p>
        </section>
      </SitePage>
    </Document>
  );
}
