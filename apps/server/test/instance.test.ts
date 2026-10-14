import { describe, expect, it } from 'vitest';
import { decidePublicBaseUrl } from '../src/instance';

describe('decidePublicBaseUrl', () => {
  it('accepts the URL recorded at setup', () => {
    expect(decidePublicBaseUrl('https://credforge.app', 'https://credforge.app', false)).toEqual({
      action: 'ok',
    });
  });

  it('refuses a different URL by default', () => {
    expect(decidePublicBaseUrl('https://credforge.app', 'https://example.org', false)).toEqual({
      action: 'reject',
      previous: 'https://credforge.app',
    });
  });

  it('allows a deliberate change', () => {
    expect(decidePublicBaseUrl('https://credforge.app', 'https://example.org', true)).toEqual({
      action: 'change',
      previous: 'https://credforge.app',
    });
  });
});
