interface MediaRange {
  type: string;
  subtype: string;
  q: number;
}

function parseAccept(header: string | undefined): MediaRange[] {
  if (!header?.trim()) return [{ type: '*', subtype: '*', q: 1 }];
  const ranges: MediaRange[] = [];
  for (const part of header.split(',')) {
    const [range = '', ...params] = part.trim().split(';');
    const [type, subtype] = range.trim().toLowerCase().split('/');
    if (!type || !subtype) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key?.trim().toLowerCase() === 'q') {
        const parsed = Number(value);
        q = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
      }
    }
    ranges.push({ type, subtype, q });
  }
  return ranges;
}

/** 2 for an exact match, 1 for `type/*`, 0 for `*\/*`, -1 for none. */
function specificity(range: MediaRange, type: string, subtype: string): number {
  if (range.type === type && range.subtype === subtype) return 2;
  if (range.type === type && range.subtype === '*') return 1;
  if (range.type === '*' && range.subtype === '*') return 0;
  return -1;
}

/**
 * Picks the best of `offers` for an `Accept` header (RFC 9110 §12.5.1): highest quality, then
 * the most specific match, then the order of `offers`. Returns null if nothing is acceptable.
 * A missing header accepts anything, so the first offer wins.
 */
export function negotiate<T extends string>(
  accept: string | undefined,
  offers: readonly T[],
): T | null {
  const ranges = parseAccept(accept);
  let best: { offer: T; q: number; specificity: number } | null = null;
  for (const offer of offers) {
    const [type = '', subtype = ''] = offer.split('/');
    // The most specific matching range decides this offer's quality.
    let match: { q: number; specificity: number } | null = null;
    for (const range of ranges) {
      const s = specificity(range, type, subtype);
      if (s >= 0 && (!match || s > match.specificity)) match = { q: range.q, specificity: s };
    }
    if (!match || match.q === 0) continue;
    if (!best || match.q > best.q || (match.q === best.q && match.specificity > best.specificity)) {
      best = { offer, ...match };
    }
  }
  return best?.offer ?? null;
}
