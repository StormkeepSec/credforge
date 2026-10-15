import { Readable } from 'node:stream';
import { BATCH_LIMITS, type BatchColumnTarget, emailField } from '@credforge/contracts';
import type { BatchColumn, BatchRowIssue, BatchRowValues } from '@credforge/db';
import { parse } from 'csv-parse';

/** A file that can't be read as a CSV of recipients. */
export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

export interface CsvLimits {
  maxRows: number;
  maxColumns: number;
  maxCell: number;
}

const DEFAULT_LIMITS: CsvLimits = {
  maxRows: BATCH_LIMITS.maxRows,
  maxColumns: BATCH_LIMITS.maxColumns,
  maxCell: BATCH_LIMITS.maxCell,
};

/**
 * Text from the file's bytes: UTF-8 (with or without a byte order mark), or Windows-1252 when
 * the bytes aren't valid UTF-8 (what Excel on Windows saves as "CSV" in many locales).
 */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/**
 * The field separator: comma, semicolon (Excel in locales with a decimal comma) or tab, whichever
 * appears most often outside quotes on the first line.
 */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && char in counts) counts[char as keyof typeof counts]++;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  return ',';
}

/**
 * Reads the file's records with a streaming parser (csv-parse) and stops as soon as the file has
 * more rows than allowed, so a huge file is never held as records. Blank lines are skipped and
 * cells are trimmed. `maxRows` counts data rows; one more line is allowed for the header.
 */
export async function parseCsv(
  bytes: Uint8Array,
  limits: CsvLimits = DEFAULT_LIMITS,
): Promise<string[][]> {
  const text = decodeCsv(bytes).replace(/^﻿/, '');
  if (text.trim() === '') throw new CsvError('The file is empty.');
  const parser = parse({
    delimiter: detectDelimiter(text),
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    skip_records_with_empty_values: true,
    trim: true,
    max_record_size: limits.maxCell * limits.maxColumns,
  });
  const records: string[][] = [];
  try {
    for await (const record of Readable.from([text]).pipe(parser) as AsyncIterable<string[]>) {
      if (record.length > limits.maxColumns) {
        throw new CsvError(`The file has more than ${limits.maxColumns} columns.`);
      }
      const long = record.findIndex((cell) => cell.length > limits.maxCell);
      if (long !== -1) {
        throw new CsvError(
          `Line ${records.length + 1} has a value longer than ${limits.maxCell.toLocaleString('en-US')} characters.`,
        );
      }
      records.push(record);
      if (records.length > limits.maxRows + 1) {
        throw new CsvError(
          `The file has more than ${limits.maxRows.toLocaleString('en-US')} rows. Split it into smaller files.`,
        );
      }
    }
  } catch (error) {
    parser.destroy();
    if (error instanceof CsvError) throw error;
    throw new CsvError(`The file isn’t a readable CSV file: ${(error as Error).message}`);
  }
  if (records.length === 0) throw new CsvError('The file has no rows.');
  return records;
}

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A first line is column names unless one of its cells is an email address. */
export function looksLikeHeader(first: string[]): boolean {
  return !first.some((cell) => EMAIL_LIKE.test(cell));
}

const SYNONYMS: [BatchColumnTarget, string[]][] = [
  ['email', ['email', 'emailaddress', 'mail', 'recipientemail', 'emailid']],
  [
    'name',
    [
      'name',
      'fullname',
      'recipient',
      'recipientname',
      'studentname',
      'learnername',
      'participantname',
      'attendeename',
      'learner',
      'student',
      'participant',
      'displayname',
    ],
  ],
  ['firstName', ['firstname', 'givenname', 'first', 'forename']],
  ['lastName', ['lastname', 'surname', 'familyname', 'last']],
  [
    'issuedOn',
    [
      'awarddate',
      'issuedate',
      'issuedon',
      'issued',
      'dateissued',
      'date',
      'awardedon',
      'completiondate',
      'completedon',
      'completed',
      'earnedon',
    ],
  ],
  [
    'expiresOn',
    ['expirydate', 'expirationdate', 'expires', 'expireson', 'expiry', 'expiration', 'validuntil'],
  ],
  ['evidenceUrl', ['evidence', 'evidenceurl', 'evidencelink', 'portfolio', 'portfoliourl']],
];

const normalizeHeader = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Column names for a file without a header line: "Column 1", "Column 2", … */
export function columnNames(width: number): string[] {
  return Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
}

const DATE_LIKE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/;
const URL_LIKE = /^https?:\/\//i;

/**
 * Guesses what each column holds, from its name (synonyms like "E-mail" or "Completion date") or,
 * when the file has no header line, from its values. Each field is used once; anything else is
 * kept as a custom field.
 */
export function detectColumns(
  headers: string[],
  samples: string[][],
  hasHeader: boolean,
): BatchColumnTarget[] {
  const targets: BatchColumnTarget[] = headers.map(() => 'custom');
  const taken = new Set<BatchColumnTarget>();
  const assign = (index: number, target: BatchColumnTarget) => {
    if (taken.has(target) || targets[index] !== 'custom') return;
    targets[index] = target;
    taken.add(target);
  };

  if (hasHeader) {
    for (const [target, names] of SYNONYMS) {
      const index = headers.findIndex((header) => names.includes(normalizeHeader(header)));
      if (index !== -1) assign(index, target);
    }
  } else {
    const column = (index: number) => samples.map((row) => row[index] ?? '').filter(Boolean);
    const share = (index: number, pattern: RegExp) => {
      const values = column(index);
      return values.length === 0 ? 0 : values.filter((v) => pattern.test(v)).length / values.length;
    };
    headers.forEach((_, index) => {
      if (share(index, EMAIL_LIKE) > 0.5) assign(index, 'email');
    });
    headers.forEach((_, index) => {
      if (share(index, DATE_LIKE) > 0.5)
        assign(index, taken.has('issuedOn') ? 'expiresOn' : 'issuedOn');
      else if (share(index, URL_LIKE) > 0.5) assign(index, 'evidenceUrl');
    });
    const textColumn = headers.findIndex(
      (_, index) => targets[index] === 'custom' && column(index).length > 0,
    );
    if (textColumn !== -1) assign(textColumn, 'name');
  }
  // First and last name columns only matter when there is no full name.
  if (taken.has('name')) {
    targets.forEach((target, index) => {
      if (target === 'firstName' || target === 'lastName') targets[index] = 'custom';
    });
  }
  return targets;
}

export interface MappedRow {
  values: BatchRowValues;
  issues: BatchRowIssue[];
}

const DAY = 24 * 60 * 60 * 1000;
const ISO_DATE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A date cell as `YYYY-MM-DD` (or an ISO date-time). Day-first and month-first dates like
 * 02/11/2026 are ambiguous, so they are refused rather than guessed.
 */
export function parseDateCell(value: string): string | null {
  const date = ISO_DATE.exec(value);
  if (date) {
    const [, y, m, d] = date as unknown as [string, string, string, string];
    const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const parsed = new Date(`${iso}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(iso) ? iso : null;
  }
  if (ISO_DATE_TIME.test(value) && !Number.isNaN(new Date(value).getTime())) return value;
  return null;
}

function dateValue(value: string, end: boolean): Date {
  return new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${end ? '23:59:59' : '00:00:00'}Z` : value,
  );
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.');
  } catch {
    return false;
  }
}

/**
 * A row's values under a column mapping, with everything wrong with them: the checks that need
 * only the row itself. Duplicates and existing holders are found across rows (`checkRows`).
 */
export function mapRow(cells: string[], columns: BatchColumn[], now = new Date()): MappedRow {
  const issues: BatchRowIssue[] = [];
  const cell = (target: BatchColumnTarget) => {
    const index = columns.findIndex((column) => column.target === target);
    return index === -1 ? '' : (cells[index] ?? '').trim();
  };
  const name =
    cell('name') || [cell('firstName'), cell('lastName')].filter(Boolean).join(' ').trim();
  const values: BatchRowValues = {
    name: name.replace(/\s+/g, ' '),
    email: cell('email'),
    custom: {},
  };

  if (!values.name) issues.push({ field: 'name', message: 'The name is missing' });
  else if (values.name.length > 200) {
    issues.push({ field: 'name', message: 'The name is longer than 200 characters' });
  }

  if (!values.email) issues.push({ field: 'email', message: 'The email address is missing' });
  else {
    const email = emailField.safeParse(values.email);
    if (email.success) values.email = email.data;
    else issues.push({ field: 'email', message: `“${values.email}” isn’t a valid email address` });
  }

  const issued = cell('issuedOn');
  if (issued) {
    const parsed = parseDateCell(issued);
    if (!parsed) {
      issues.push({
        field: 'issuedOn',
        message: `Use YYYY-MM-DD for the award date (not “${issued}”)`,
      });
    } else if (dateValue(parsed, false).getTime() > now.getTime() + DAY) {
      issues.push({ field: 'issuedOn', message: 'The award date is in the future' });
    } else values.issuedOn = parsed;
  }

  const expires = cell('expiresOn');
  if (expires) {
    const parsed = parseDateCell(expires);
    if (!parsed) {
      issues.push({
        field: 'expiresOn',
        message: `Use YYYY-MM-DD for the expiry date (not “${expires}”)`,
      });
    } else {
      const from = values.issuedOn ? dateValue(values.issuedOn, false) : now;
      if (dateValue(parsed, true).getTime() <= from.getTime()) {
        issues.push({ field: 'expiresOn', message: 'The expiry date is before the award date' });
      } else values.expiresOn = parsed;
    }
  }

  const evidence = cell('evidenceUrl');
  if (evidence) {
    if (isWebUrl(evidence) && evidence.length <= 2000) values.evidenceUrl = evidence;
    else
      issues.push({ field: 'evidenceUrl', message: 'The evidence link isn’t a full web address' });
  }

  columns.forEach((column, index) => {
    const value = (cells[index] ?? '').trim();
    if (column.target !== 'custom' || !value) return;
    const key = column.header.trim().slice(0, 100) || `Column ${index + 1}`;
    if (Object.keys(values.custom).length < BATCH_LIMITS.maxCustomFields)
      values.custom[key] = value;
  });
  return { values, issues };
}

/** Whether a mapping has what every row needs: an email column and a name (or first and last). */
export function mappingProblems(columns: BatchColumn[]): string[] {
  const targets = new Set(columns.map((column) => column.target));
  const problems: string[] = [];
  if (!targets.has('email')) problems.push('Choose the column with the email addresses.');
  if (!targets.has('name') && !targets.has('firstName') && !targets.has('lastName')) {
    problems.push('Choose the column with the names (or the first and last names).');
  }
  for (const target of [
    'name',
    'firstName',
    'lastName',
    'email',
    'issuedOn',
    'expiresOn',
    'evidenceUrl',
  ] as const) {
    if (columns.filter((column) => column.target === target).length > 1) {
      problems.push('Each kind of value can come from one column only.');
      break;
    }
  }
  return problems;
}

// ---- writing CSV ----

/**
 * One CSV cell, quoted when needed. A value a spreadsheet would run as a formula (starting with
 * `=`, `+`, `-`, `@`, a tab or a carriage return) gets a leading apostrophe, so an export opened
 * in Excel or Sheets shows the text instead of running it (OWASP "CSV injection").
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values: unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

/** The byte order mark Excel needs to read a CSV file as UTF-8. */
export const CSV_BOM = '﻿';

/** The downloadable template: the column names credforge recognizes. */
export const TEMPLATE_CSV = `${CSV_BOM}${csvLine(['Name', 'Email', 'Award date', 'Expiry date', 'Evidence link'])}`;
