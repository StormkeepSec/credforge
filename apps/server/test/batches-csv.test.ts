import type { BatchColumn } from '@credforge/db';
import { describe, expect, it } from 'vitest';
import {
  CsvError,
  csvCell,
  csvLine,
  decodeCsv,
  detectColumns,
  detectDelimiter,
  looksLikeHeader,
  mappingProblems,
  mapRow,
  parseCsv,
  parseDateCell,
  TEMPLATE_CSV,
} from '../src/batches/csv';

const bytes = (text: string) => Buffer.from(text, 'utf8');
const columns = (...targets: BatchColumn['target'][]): BatchColumn[] =>
  targets.map((target, index) => ({ header: `Column ${index + 1}`, target }));

describe('reading CSV files', () => {
  it('reads quoted cells, CRLF line ends, a BOM and blank lines', async () => {
    const records = await parseCsv(
      bytes(
        '﻿Name,Email\r\n"Rivera, Jordan",jordan@example.org\r\n\r\n"Sam ""S"" Lee", sam@example.org \r\n',
      ),
    );
    expect(records).toEqual([
      ['Name', 'Email'],
      ['Rivera, Jordan', 'jordan@example.org'],
      ['Sam "S" Lee', 'sam@example.org'],
    ]);
  });

  it('reads cells that span lines', async () => {
    const records = await parseCsv(bytes('Name,Note\nJordan,"line one\nline two"\n'));
    expect(records[1]).toEqual(['Jordan', 'line one\nline two']);
  });

  it('detects semicolons and tabs', async () => {
    expect(detectDelimiter('Name;Email\nA;b@example.org')).toBe(';');
    expect(detectDelimiter('Name\tEmail\n')).toBe('\t');
    expect(detectDelimiter('"Last; First",Email\n')).toBe(',');
    expect(await parseCsv(bytes('Name;Email\nJordan;j@example.org\n'))).toEqual([
      ['Name', 'Email'],
      ['Jordan', 'j@example.org'],
    ]);
  });

  it('falls back to Windows-1252 for files that aren’t UTF-8', () => {
    expect(decodeCsv(Buffer.from([0x4a, 0x6f, 0x73, 0xe9]))).toBe('José');
    expect(decodeCsv(bytes('José'))).toBe('José');
  });

  it('stops at the row limit instead of reading everything', async () => {
    const limits = { maxRows: 3, maxColumns: 10, maxCell: 100 };
    const ok = `Name,Email\n${'a,a@example.org\n'.repeat(3)}`;
    expect(await parseCsv(bytes(ok), limits)).toHaveLength(4);
    const tooMany = `Name,Email\n${'a,a@example.org\n'.repeat(50_000)}`;
    await expect(parseCsv(bytes(tooMany), limits)).rejects.toThrow(/more than 3 rows/);
  });

  it('refuses empty files, too many columns and huge cells', async () => {
    const limits = { maxRows: 10, maxColumns: 3, maxCell: 10 };
    await expect(parseCsv(bytes('  \n\n'), limits)).rejects.toBeInstanceOf(CsvError);
    await expect(parseCsv(bytes('a,b,c,d\n'), limits)).rejects.toThrow(/more than 3 columns/);
    await expect(parseCsv(bytes(`a,${'x'.repeat(11)}\n`), limits)).rejects.toThrow(/longer than/);
  });
});

describe('recognizing columns', () => {
  it('recognizes common column names', () => {
    const headers = ['Full name', 'E-mail', 'Completion date', 'Expiry', 'Portfolio', 'Cohort'];
    expect(detectColumns(headers, [], true)).toEqual([
      'name',
      'email',
      'issuedOn',
      'expiresOn',
      'evidenceUrl',
      'custom',
    ]);
  });

  it('uses first and last names when there is no full name', () => {
    expect(detectColumns(['First name', 'Last name', 'Email'], [], true)).toEqual([
      'firstName',
      'lastName',
      'email',
    ]);
    expect(detectColumns(['Name', 'First name', 'Email'], [], true)).toEqual([
      'name',
      'custom',
      'email',
    ]);
  });

  it('guesses from the values when the file has no header line', () => {
    const rows = [
      ['jordan@example.org', 'Jordan Rivera', '2026-01-02', 'https://example.org/j'],
      ['sam@example.org', 'Sam Lee', '2026-01-03', 'https://example.org/s'],
    ];
    expect(looksLikeHeader(rows[0] as string[])).toBe(false);
    expect(looksLikeHeader(['Name', 'Email'])).toBe(true);
    expect(detectColumns(['Column 1', 'Column 2', 'Column 3', 'Column 4'], rows, false)).toEqual([
      'email',
      'name',
      'issuedOn',
      'evidenceUrl',
    ]);
  });

  it('says what a mapping is missing', () => {
    expect(mappingProblems(columns('name', 'email'))).toEqual([]);
    expect(mappingProblems(columns('firstName', 'lastName', 'email'))).toEqual([]);
    expect(mappingProblems(columns('name', 'custom'))).toEqual([
      'Choose the column with the email addresses.',
    ]);
    expect(mappingProblems(columns('email', 'email', 'name'))).toEqual([
      'Each kind of value can come from one column only.',
    ]);
  });

  it('ships a template whose columns are recognized', () => {
    const header = TEMPLATE_CSV.replace('﻿', '').trim().split(',');
    expect(detectColumns(header, [], true)).toEqual([
      'name',
      'email',
      'issuedOn',
      'expiresOn',
      'evidenceUrl',
    ]);
  });
});

describe('checking a row', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const mapping: BatchColumn[] = [
    { header: 'Name', target: 'name' },
    { header: 'Email', target: 'email' },
    { header: 'Award date', target: 'issuedOn' },
    { header: 'Expiry date', target: 'expiresOn' },
    { header: 'Evidence', target: 'evidenceUrl' },
    { header: 'Cohort', target: 'custom' },
    { header: 'Notes', target: 'ignore' },
  ];

  it('normalizes a good row', () => {
    const row = mapRow(
      [
        ' Jordan  Rivera ',
        'Jordan@Example.ORG',
        '2026/1/5',
        '2027-01-05',
        'https://example.org/p',
        'Fall',
        'x',
      ],
      mapping,
      now,
    );
    expect(row.issues).toEqual([]);
    expect(row.values).toEqual({
      name: 'Jordan Rivera',
      email: 'jordan@example.org',
      issuedOn: '2026-01-05',
      expiresOn: '2027-01-05',
      evidenceUrl: 'https://example.org/p',
      custom: { Cohort: 'Fall' },
    });
  });

  it('joins first and last names', () => {
    const row = mapRow(
      ['Jordan', 'Rivera', 'j@example.org'],
      columns('firstName', 'lastName', 'email'),
      now,
    );
    expect(row.values.name).toBe('Jordan Rivera');
  });

  it('reports every problem in a row', () => {
    const row = mapRow(
      ['', 'not-an-email', '02/11/2026', '2020-01-01', 'ftp://x', '', ''],
      mapping,
      now,
    );
    expect(row.issues.map((issue) => issue.field)).toEqual([
      'name',
      'email',
      'issuedOn',
      'expiresOn',
      'evidenceUrl',
    ]);
  });

  it('refuses future award dates and expiry before the award', () => {
    expect(mapRow(['A', 'a@example.org', '2027-01-01'], mapping, now).issues[0]?.message).toMatch(
      /future/,
    );
    expect(
      mapRow(['A', 'a@example.org', '2026-05-01', '2026-04-01'], mapping, now).issues[0]?.message,
    ).toMatch(/before the award/);
  });

  it('reads only unambiguous dates', () => {
    expect(parseDateCell('2026-11-02')).toBe('2026-11-02');
    expect(parseDateCell('2026/11/2')).toBe('2026-11-02');
    expect(parseDateCell('2026-02-30')).toBeNull();
    expect(parseDateCell('02/11/2026')).toBeNull();
    expect(parseDateCell('2026-11-02T10:00:00Z')).toBe('2026-11-02T10:00:00Z');
  });
});

describe('writing CSV', () => {
  it('quotes when needed', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
    expect(csvLine(['a', 'b'])).toBe('a,b\r\n');
  });

  it('keeps spreadsheets from running values as formulas', () => {
    for (const value of [
      '=1+1',
      '+SUM(A1)',
      '-2+3',
      '@cmd',
      '\tx',
      '\rx',
      '=HYPERLINK("http://x")',
    ]) {
      const cell = csvCell(value);
      const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
      expect(unquoted.startsWith("'"), value).toBe(true);
    }
    expect(csvCell('jordan@example.org')).toBe('jordan@example.org');
  });
});
