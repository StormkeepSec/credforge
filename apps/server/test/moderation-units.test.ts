import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { findBlockedTerms, normalizedWords, parseBlocklist } from '../src/moderation/blocklist';
import { achievementText, issuerText, textHash } from '../src/moderation/content';
import { placeholderPng, placeholderSvg } from '../src/moderation/placeholders';
import {
  checkReportFormToken,
  REPORT_FORM_MAX_AGE_MS,
  reportFormToken,
} from '../src/moderation/reports';
import { reviewRequired } from '../src/moderation/service';

// Made-up terms: credforge ships no word list.
const list = parseBlocklist(
  ['# comments and blank lines are ignored', '', 'zorblax', '=dang', '=snork wib', 'Zorblax'].join(
    '\n',
  ),
);

describe('the word list', () => {
  it('parses one term per line, whole-word terms with =, without duplicates', () => {
    expect(list.terms.map((term) => [term.term, term.wholeWord])).toEqual([
      ['zorblax', false],
      ['=dang', true],
      ['=snork wib', true],
    ]);
    expect(parseBlocklist(undefined).terms).toEqual([]);
    expect(parseBlocklist('   \n# only a comment').terms).toEqual([]);
  });

  it('normalizes case, accents, look-alike letters and common swaps', () => {
    expect(normalizedWords('ZÖRBLÄX')).toEqual(['zorblax']);
    expect(normalizedWords('z0rbl@x')).toEqual(['zorblax']);
    // Cyrillic о and а, full-width letters.
    expect(normalizedWords('zоrblаx')).toEqual(['zorblax']);
    expect(normalizedWords('ｚｏｒｂｌａｘ')).toEqual(['zorblax']);
    expect(normalizedWords('Straße, Ærø')).toEqual(['strasse', 'aero']);
  });

  it('finds terms inside words, across punctuation and repeated letters', () => {
    for (const text of [
      'zorblax',
      'The Zorblaxian method',
      'z.o.r.b.l.a.x',
      'z o r b l a x',
      'zoooorblaaax',
      'Z0RBL@X',
    ]) {
      expect(findBlockedTerms(list, [text]), text).toEqual(['zorblax']);
    }
    // Not across two separate values.
    expect(findBlockedTerms(list, ['zor', 'blax'])).toEqual([]);
  });

  it('matches whole-word terms and phrases only as words', () => {
    expect(findBlockedTerms(list, ['Dangerous goods'])).toEqual([]);
    expect(findBlockedTerms(list, ['Oh, dang!'])).toEqual(['=dang']);
    expect(findBlockedTerms(list, ['DAAANG it'])).toEqual(['=dang']);
    expect(findBlockedTerms(list, ['a snork wib here'])).toEqual(['=snork wib']);
    expect(findBlockedTerms(list, ['snorkwib', 'snork wibble'])).toEqual([]);
  });

  it('comes from MODERATION_TEXT_BLOCKLIST, or a file through _FILE', () => {
    const base = {
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'https://credforge.test',
      DATABASE_URL: 'postgres://x',
    };
    expect(loadConfig(base).moderation).toEqual({ review: 'untrusted', blocklist: { terms: [] } });
    const config = loadConfig({
      ...base,
      MODERATION_TEXT_BLOCKLIST: 'zorblax',
      MODERATION_REVIEW: 'off',
    });
    expect(config.moderation.review).toBe('off');
    expect(config.moderation.blocklist.terms).toHaveLength(1);
    expect(() => loadConfig({ ...base, MODERATION_REVIEW: 'sometimes' })).toThrow(
      /MODERATION_REVIEW/,
    );
    expect(() =>
      loadConfig({ ...base, MODERATION_TEXT_BLOCKLIST_FILE: '/nonexistent/credforge-words.txt' }),
    ).toThrow(/cannot read file/);
  });
});

describe('the review policy', () => {
  const trusted = { trustedAt: new Date() };
  const untrusted = { trustedAt: null };
  const policy = (review: 'untrusted' | 'all' | 'off') => ({ review, blocklist: { terms: [] } });

  it('holds untrusted orgs by default, every org with all, none with off', () => {
    expect(reviewRequired(policy('untrusted'), untrusted)).toBe(true);
    expect(reviewRequired(policy('untrusted'), trusted)).toBe(false);
    expect(reviewRequired(policy('all'), trusted)).toBe(true);
    expect(reviewRequired(policy('off'), untrusted)).toBe(false);
  });
});

describe('content hashes', () => {
  it('are the same for the same text, whatever the row holds besides', () => {
    const row = {
      name: 'Intro',
      description: 'Basics.',
      criteriaNarrative: null,
      criteriaUrl: null,
      tags: ['a'],
      alignments: [],
    };
    expect(textHash(achievementText(row))).toBe(
      textHash(achievementText({ ...row, tags: [...row.tags] })),
    );
    expect(textHash(achievementText(row))).not.toBe(
      textHash(achievementText({ ...row, name: 'Intro!' })),
    );
    expect(
      issuerText({ name: 'A', description: null, url: 'https://a.example', email: null }),
    ).toEqual({
      name: 'A',
      description: null,
      website: 'https://a.example',
      email: null,
    });
  });
});

describe('the report form token', () => {
  const secret = 'a-secret-at-least-thirty-two-characters-long';
  const target = { type: 'issuer', id: '7f3e9a52-0000-4000-8000-000000000000' };

  it('is signed for one page and accepted from a few seconds to a day after it was made', () => {
    const now = Date.now();
    const token = reportFormToken(secret, target, now);
    expect(checkReportFormToken(secret, target, token, now + 10_000)).toBe('ok');
    expect(checkReportFormToken(secret, target, token, now + 1_000)).toBe('too_fast');
    expect(checkReportFormToken(secret, target, token, now + REPORT_FORM_MAX_AGE_MS + 1)).toBe(
      'invalid',
    );
    expect(
      checkReportFormToken(secret, { ...target, type: 'credential' }, token, now + 10_000),
    ).toBe('invalid');
    expect(
      checkReportFormToken('another-secret-of-thirty-two-chars!!', target, token, now + 10_000),
    ).toBe('invalid');
    expect(checkReportFormToken(secret, target, `${token}x`, now + 10_000)).toBe('invalid');
    expect(checkReportFormToken(secret, target, undefined, now)).toBe('invalid');
  });
});

describe('placeholders', () => {
  it('are plain tiles at each size, with no text', async () => {
    for (const [size, width, height] of [
      ['original', 512, 512],
      ['512', 512, 512],
      ['128', 128, 128],
      ['og', 1200, 630],
    ] as const) {
      const meta = await sharp(await placeholderPng('removed', size)).metadata();
      expect([meta.width, meta.height], size).toEqual([width, height]);
    }
    expect(
      (await placeholderPng('held', '512')).equals(await placeholderPng('removed', '512')),
    ).toBe(false);
    expect(placeholderSvg('held')).not.toMatch(/<text/);
  });
});
