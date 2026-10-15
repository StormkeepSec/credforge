import { type ClassValue, clsx } from 'clsx';
import { useEffect } from 'react';
import { twMerge } from 'tailwind-merge';

/** Joins class names, letting later Tailwind classes override earlier ones (shadcn/ui). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Names the browser tab after the page's heading (WCAG 2.4.2), e.g. "Members · credforge". */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · credforge` : 'credforge';
  }, [title]);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * A credential's award or expiry day. A calendar date is stored as midnight (or 23:59:59) UTC, so
 * it is shown in UTC, as on the public pages: in local time it would be the day before in the
 * Americas.
 */
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Only same-site paths are followed after sign-in, never another origin. */
export function safeRedirect(value: unknown, fallback = '/app'): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : fallback;
}
