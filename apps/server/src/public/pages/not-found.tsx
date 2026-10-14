import { SitePage } from '../components/site-chrome';
import { Document } from '../document';

interface NotFoundPageProps {
  url: string;
  stylesheet: string;
}

export function NotFoundPage({ url, stylesheet }: NotFoundPageProps) {
  return (
    <Document
      title="Page not found · credforge"
      description="This page doesn't exist."
      url={url}
      stylesheet={stylesheet}
    >
      <SitePage>
        <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
          <p className="text-sm font-bold tracking-[0.15em] text-signal-strong uppercase">404</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight">Page not found</h1>
          <p className="mt-4 max-w-xl text-lg text-ink-muted">
            The link may be mistyped, or the page may have moved.
          </p>
          <a
            href="/"
            className="mt-8 inline-flex font-semibold text-signal-strong underline underline-offset-4"
          >
            Go to the home page
          </a>
        </section>
      </SitePage>
    </Document>
  );
}
