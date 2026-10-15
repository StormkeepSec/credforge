import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export interface DocumentProps {
  title: string;
  description: string;
  /** Absolute URL of this page (under PUBLIC_BASE_URL). */
  url: string;
  stylesheet: string;
  /** URL of the same resource as JSON-LD (content negotiation), if there is one. */
  alternateJson?: string;
  /** Link-preview image (Open Graph), e.g. a badge's 1200×630 card. */
  image?: { url: string; width: number; height: number; alt: string };
  /** Keep the page out of search engines (credential pages name a person). */
  noindex?: boolean;
  /** Class for <body>; the default suits the site's pages. */
  bodyClassName?: string;
  children: ReactNode;
}

/** HTML shell for every server-rendered public page. */
export function Document({
  title,
  description,
  url,
  stylesheet,
  alternateJson,
  image,
  noindex,
  bodyClassName = 'min-h-screen bg-canvas font-sans text-ink antialiased',
  children,
}: DocumentProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />
        {noindex && <meta name="robots" content="noindex, nofollow" />}
        <link rel="canonical" href={url} />
        {alternateJson && <link rel="alternate" type="application/ld+json" href={alternateJson} />}
        <meta property="og:site_name" content="credforge" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={url} />
        {image && (
          <>
            <meta property="og:image" content={image.url} />
            <meta property="og:image:width" content={String(image.width)} />
            <meta property="og:image:height" content={String(image.height)} />
            <meta property="og:image:alt" content={image.alt} />
            <meta name="twitter:card" content="summary_large_image" />
          </>
        )}
        <meta name="theme-color" content="#111827" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href={stylesheet} />
      </head>
      <body className={bodyClassName}>{children}</body>
    </html>
  );
}

export function renderDocument(page: ReactElement): string {
  return `<!doctype html>${renderToStaticMarkup(page)}`;
}
