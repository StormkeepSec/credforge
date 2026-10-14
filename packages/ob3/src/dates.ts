import type { DateTimeString } from './types';

/**
 * Formats a date as `YYYY-MM-DDThh:mm:ssZ`, the form used throughout the OB 3.0 spec. Fractional
 * seconds are dropped. Strings must parse as dates and carry a time zone.
 */
export function toDateTimeString(value: Date | string, name = 'date'): DateTimeString {
  if (typeof value === 'string' && !/(Z|[+-]\d{2}:\d{2})$/i.test(value.trim())) {
    throw new TypeError(`"${name}" must include a time zone, e.g. 2026-11-02T15:04:05Z.`);
  }
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) throw new TypeError(`"${name}" is not a valid date.`);
  return `${date.toISOString().slice(0, 19)}Z`;
}
