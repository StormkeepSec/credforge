import { describe, expect, it } from 'vitest';
import { negotiate } from '../src/public/negotiate';

const offers = ['application/json', 'application/ld+json', 'text/html'] as const;

describe('negotiate', () => {
  it('gives browsers HTML', () => {
    expect(
      negotiate('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', offers),
    ).toBe('text/html');
  });

  it('gives JSON-LD to clients that ask for it', () => {
    expect(negotiate('application/ld+json', offers)).toBe('application/ld+json');
    expect(negotiate('application/ld+json, application/json;q=0.5', offers)).toBe(
      'application/ld+json',
    );
  });

  it('gives JSON when there is no preference', () => {
    expect(negotiate(undefined, offers)).toBe('application/json');
    expect(negotiate('*/*', offers)).toBe('application/json');
    expect(negotiate('application/*', offers)).toBe('application/json');
  });

  it('prefers the more specific match at equal quality', () => {
    expect(negotiate('*/*, text/html', offers)).toBe('text/html');
  });

  it('honors q=0 and returns null when nothing fits', () => {
    expect(negotiate('application/json;q=0, */*', offers)).toBe('application/ld+json');
    expect(negotiate('image/png', offers)).toBeNull();
  });
});
