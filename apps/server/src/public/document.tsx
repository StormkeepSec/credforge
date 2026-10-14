import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export interface DocumentProps {
  title: string;
  description: string;
  /** Absolute URL of this page (under PUBLIC_BASE_URL). */
  url: string;
  stylesheet: string;
  children: ReactNode;
}

/** HTML shell for every server-rendered public page. */
export function Document({ title, description, url, stylesheet, children }: DocumentProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={url} />
        <meta property="og:site_name" content="credforge" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={url} />
        <meta name="theme-color" content="#111827" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href={stylesheet} />
      </head>
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased">{children}</body>
    </html>
  );
}

export function renderDocument(page: ReactElement): string {
  return `<!doctype html>${renderToStaticMarkup(page)}`;
}
