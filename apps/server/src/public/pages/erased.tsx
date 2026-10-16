import { SitePage } from '../components/site-chrome';
import { Document } from '../document';

interface ErasedCredentialPageProps {
  url: string;
  stylesheet: string;
  issuer: { name: string; pageUrl: string };
  achievementName: string | null;
}

/**
 * A credential whose recipient's data was erased (design plan §12.1): 410 Gone. It names only the
 * issuer and the achievement, never the person, and says what copies of the badge now show.
 */
export function ErasedCredentialPage({
  url,
  stylesheet,
  issuer,
  achievementName,
}: ErasedCredentialPageProps) {
  return (
    <Document
      title="Badge no longer available · credforge"
      description="The issuer revoked this badge and removed its details."
      url={url}
      stylesheet={stylesheet}
      noindex
    >
      <SitePage>
        <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
          <p className="text-sm font-bold tracking-[0.15em] text-signal-strong uppercase">410</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight">
            This badge is no longer available
          </h1>
          <p className="mt-4 max-w-xl text-lg text-ink-muted">
            <a
              href={issuer.pageUrl}
              className="font-semibold text-signal-strong underline underline-offset-4"
            >
              {issuer.name}
            </a>{' '}
            revoked this {achievementName ? <strong>{achievementName}</strong> : null}
            {achievementName ? ' badge' : 'badge'} and removed its details.
          </p>
          <p className="mt-4 max-w-xl text-ink-muted">
            Any copy of it, such as a downloaded file or badge image, now checks as revoked.
          </p>
        </section>
      </SitePage>
    </Document>
  );
}
