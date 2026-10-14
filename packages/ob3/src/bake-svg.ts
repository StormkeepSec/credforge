import { BakeError, type BakeOptions } from './bake-png';
import { SVG_NAMESPACE } from './constants';

const PREFIX = 'openbadges';

/**
 * Bakes a credential into an SVG (OB 3.0 §5.3.2): declares `xmlns:openbadges` on the root `<svg>`
 * and inserts `<openbadges:credential>` directly after its start tag. A credential object goes in
 * as JSON inside CDATA; a compact JWS string goes in the `verify` attribute. The SVG should already
 * be sanitized (credforge sanitizes uploads); this only edits the root element.
 */
export function bakeSvg(
  svg: string,
  credential: object | string,
  options: BakeOptions = {},
): string {
  const root = findRoot(svg);
  let declared = false;
  for (const [name, value] of root.attributes) {
    if (name === `xmlns:${PREFIX}`) {
      if (value !== SVG_NAMESPACE) {
        throw new BakeError(`The SVG already binds the "${PREFIX}" prefix to another namespace.`);
      }
      declared = true;
    }
  }

  let body = svg.slice(root.end);
  const existing = findCredentialElement(svg, root.end);
  if (existing) {
    if (!options.replace) {
      throw new BakeError('The SVG already contains an Open Badges credential.');
    }
    body = svg.slice(root.end, existing.start) + svg.slice(existing.end);
  }

  const element =
    typeof credential === 'string' && !credential.trimStart().startsWith('{')
      ? `<${PREFIX}:credential verify="${escapeAttribute(credential)}"></${PREFIX}:credential>`
      : `<${PREFIX}:credential><![CDATA[${escapeCdata(
          typeof credential === 'string' ? credential : JSON.stringify(credential),
        )}]]></${PREFIX}:credential>`;

  let startTag = svg.slice(root.start, root.end);
  const selfClosing = startTag.endsWith('/>');
  if (selfClosing) startTag = `${startTag.slice(0, -2).trimEnd()}>`;
  if (!declared) {
    startTag = `${startTag.slice(0, -1)} xmlns:${PREFIX}="${SVG_NAMESPACE}">`;
  }
  return `${svg.slice(0, root.start)}${startTag}${element}${selfClosing ? '</svg>' : ''}${body}`;
}

/**
 * Extracts the baked credential from an SVG: the `verify` attribute or the text content of the
 * first `credential` element in the OB 3.0 namespace (any prefix), or `undefined` if there is none.
 */
export function extractFromSvg(svg: string): string | undefined {
  const root = findRoot(svg);
  const element = findCredentialElement(svg, root.start);
  if (!element) return undefined;
  const verify = element.attributes.get('verify');
  if (verify !== undefined) return verify;
  return textContent(svg.slice(element.contentStart, element.contentEnd)).trim();
}

interface StartTag {
  start: number;
  end: number;
  attributes: Map<string, string>;
}

// Skips the XML declaration, comments, processing instructions and a doctype to reach `<svg`.
function findRoot(svg: string): StartTag {
  let position = svg.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (position < svg.length && /\s/.test(svg.charAt(position))) position++;
    if (svg.startsWith('<?', position)) {
      position = endOf(svg, '?>', position);
    } else if (svg.startsWith('<!--', position)) {
      position = endOf(svg, '-->', position);
    } else if (/^<!DOCTYPE/i.test(svg.slice(position, position + 9))) {
      const subset = svg.indexOf('[', position);
      const close = svg.indexOf('>', position);
      position = subset !== -1 && subset < close ? endOf(svg, ']>', subset) : close + 1;
      if (position === 0) throw new BakeError('The SVG has an unterminated doctype.');
    } else if (/^<svg[\s/>]/.test(svg.slice(position, position + 5))) {
      return readStartTag(svg, position);
    } else {
      throw new BakeError('Not an SVG image: the root element must be <svg>.');
    }
  }
}

function endOf(text: string, terminator: string, from: number): number {
  const index = text.indexOf(terminator, from);
  if (index === -1) throw new BakeError('The SVG is malformed.');
  return index + terminator.length;
}

function readStartTag(svg: string, start: number): StartTag {
  let quote = '';
  for (let i = start + 1; i < svg.length; i++) {
    const char = svg.charAt(i);
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return { start, end: i + 1, attributes: parseAttributes(svg.slice(start, i + 1)) };
    }
  }
  throw new BakeError('The SVG has an unterminated tag.');
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/([^\s=<>/"']+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const [, name, , double, single] = match;
    if (name) attributes.set(name, decodeEntities(double ?? single ?? ''));
  }
  return attributes;
}

interface Element extends StartTag {
  contentStart: number;
  contentEnd: number;
}

// Finds the first `<p:credential>` whose prefix `p` is declared anywhere for the OB 3.0 namespace.
function findCredentialElement(svg: string, from: number): Element | undefined {
  const prefixes = new Set<string>();
  for (const match of svg.matchAll(/xmlns:([\w.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    if (match[1] && (match[3] ?? match[4]) === SVG_NAMESPACE) prefixes.add(match[1]);
  }
  let found: Element | undefined;
  for (const prefix of prefixes) {
    const pattern = new RegExp(`<${escapeRegExp(prefix)}:credential[\\s/>]`, 'g');
    pattern.lastIndex = from;
    const match = pattern.exec(svg);
    if (!match || (found && found.start < match.index)) continue;
    const tag = readStartTag(svg, match.index);
    if (svg.slice(tag.start, tag.end).endsWith('/>')) {
      found = { ...tag, contentStart: tag.end, contentEnd: tag.end };
      continue;
    }
    const closing = `</${prefix}:credential>`;
    const close = svg.indexOf(closing, tag.end);
    if (close === -1) throw new BakeError('The SVG credential element is not closed.');
    found = { ...tag, end: close + closing.length, contentStart: tag.end, contentEnd: close };
  }
  return found;
}

// Text content: CDATA sections verbatim, other text with entities decoded, comments dropped.
function textContent(xml: string): string {
  let text = '';
  let position = 0;
  while (position < xml.length) {
    if (xml.startsWith('<![CDATA[', position)) {
      const end = endOf(xml, ']]>', position);
      text += xml.slice(position + 9, end - 3);
      position = end;
    } else if (xml.startsWith('<!--', position)) {
      position = endOf(xml, '-->', position);
    } else {
      const next = xml.indexOf('<', position);
      const end = next === -1 ? xml.length : next;
      if (next === position) {
        throw new BakeError('Unexpected markup inside the credential element.');
      }
      text += decodeEntities(xml.slice(position, end));
      position = end;
    }
  }
  return text;
}

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return NAMED_ENTITIES[name] ?? entity;
    const hex = name[1] === 'x' || name[1] === 'X';
    const codePoint = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    // A reference to a code point that doesn't exist is left as it is rather than throwing.
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  });
}

// `]]>` cannot appear inside CDATA, so it is split across two sections.
function escapeCdata(text: string): string {
  return text.replaceAll(']]>', ']]]]><![CDATA[>');
}

function escapeAttribute(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
