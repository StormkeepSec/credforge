/**
 * The operator's word list (MODERATION_TEXT_BLOCKLIST, usually from a file with `_FILE`; design
 * plan §6.5). credforge ships none: what to list is the operator's choice. Public text containing
 * a listed term is held for review, never refused, because matching parts of words also catches
 * innocent ones ("Scunthorpe"); a person decides.
 *
 * File format: one term per line. Blank lines and lines starting with `#` are ignored. A term
 * matches anywhere, even inside a longer word and across spaces or punctuation ("b.a.d" and
 * "baaad" match "bad"). A term starting with `=` matches only whole words (`=ass` doesn't match
 * "class"), for short words that are often part of innocent ones. Several words after `=` match
 * as that phrase.
 *
 * Both the text and the terms are normalized the same way: Unicode compatibility forms and
 * accents removed, lowercase, common look-alike letters (Cyrillic and Greek) and character swaps
 * (`0` for o, `1` for i, `3` for e, `4` and `@` for a, `5` and `$` for s, `7` for t, …) replaced,
 * and repeated letters collapsed.
 */

export interface BlockTerm {
  /** The line as the operator wrote it, shown to platform admins with a match. */
  term: string;
  wholeWord: boolean;
  /** Normalized: one string for a term, the words for a whole-word phrase. */
  pattern: string;
  words: string[];
}

export interface Blocklist {
  terms: BlockTerm[];
}

const SWAPS: Record<string, string> = {
  // Look-alike letters from other scripts (lowercase; NFKD leaves them alone).
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  // Letters without a decomposition.
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  ı: 'i',
  þ: 'th',
  // Common swaps.
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '€': 'e',
  '+': 't',
};

/** Symbols stand for letters only inside a word ("sh!t"), not as punctuation after it ("oh!"). */
const SYMBOL = /[^\p{L}\p{N}]/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Splits text into normalized words (letters and digits only, swaps applied). */
export function normalizedWords(text: string): string[] {
  const folded = [...text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()];
  let mapped = '';
  folded.forEach((char, index) => {
    const swap = SWAPS[char];
    const inWord = !SYMBOL.test(char) || WORD_CHAR.test(folded[index + 1] ?? '');
    mapped += swap !== undefined && inWord ? swap : char;
  });
  return mapped.split(/[^a-z0-9]+/).filter(Boolean);
}

/** Collapses repeated letters: "baaad" → "bad". */
function collapse(value: string): string {
  return value.replace(/(.)\1+/g, '$1');
}

export function parseBlocklist(source: string | undefined): Blocklist {
  const terms: BlockTerm[] = [];
  const seen = new Set<string>();
  for (const raw of (source ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const wholeWord = line.startsWith('=');
    const normalized = normalizedWords(wholeWord ? line.slice(1) : line);
    const words = normalized.map(collapse);
    const pattern = collapse(normalized.join(''));
    if (!pattern) continue;
    const key = `${wholeWord ? '=' : ''}${words.join(' ')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push({ term: line, wholeWord, pattern, words });
  }
  return { terms };
}

/** The listed terms found in any of the texts (as the operator wrote them), in list order. */
export function findBlockedTerms(list: Blocklist, texts: string[]): string[] {
  if (list.terms.length === 0) return [];
  // Per text, so a term doesn't match across two separate values (a name and a description).
  const normalized = texts.map((text) => normalizedWords(text));
  const squashed = normalized.map((words) => collapse(words.join('')));
  const spaced = normalized.map((words) => ` ${words.map(collapse).join(' ')} `);
  return list.terms
    .filter((term) =>
      term.wholeWord
        ? spaced.some((value) => value.includes(` ${term.words.join(' ')} `))
        : squashed.some((value) => value.includes(term.pattern)),
    )
    .map((term) => term.term);
}
