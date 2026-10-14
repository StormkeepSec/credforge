import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  BakeError,
  bakePng,
  bakeSvg,
  buildCredential,
  extractFromPng,
  extractFromSvg,
  signCredential,
} from '../src/index';
import { credentialInput, makePng, testIssuer } from './support/fixtures';

async function signedCredential() {
  const { signer } = await testIssuer();
  return signCredential(buildCredential(credentialInput()), signer);
}

/** Lists chunk types and the raw iTXt payloads of a PNG (independent reader). */
function chunks(png: Uint8Array) {
  const buffer = Buffer.from(png);
  const out: Array<{ type: string; data: Buffer }> = [];
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    out.push({
      type: buffer.toString('latin1', offset + 4, offset + 8),
      data: buffer.subarray(offset + 8, offset + 8 + length),
    });
    offset += length + 12;
  }
  return out;
}

describe('PNG baking (OB 3.0 §5.3.1)', () => {
  it('round-trips a signed credential', async () => {
    const credential = await signedCredential();
    const baked = bakePng(makePng(), credential);
    const text = extractFromPng(baked);
    expect(text).toBeDefined();
    expect(JSON.parse(text as string)).toEqual(credential);
  });

  it('writes one uncompressed iTXt chunk with keyword openbadgecredential after IHDR', async () => {
    const credential = await signedCredential();
    const original = makePng();
    const baked = bakePng(original, credential);
    const list = chunks(baked);
    expect(list.map((chunk) => chunk.type)).toEqual(['IHDR', 'iTXt', 'IDAT', 'IEND']);
    const itxt = list[1]?.data as Buffer;
    const expected = Buffer.concat([
      Buffer.from('openbadgecredential\0', 'latin1'),
      Buffer.of(0, 0), // compression flag and method: none
      Buffer.of(0, 0), // empty language tag and translated keyword
      Buffer.from(JSON.stringify(credential), 'utf8'),
    ]);
    expect(itxt.equals(expected)).toBe(true);
    // The image data is untouched.
    expect(list[2]?.data.equals(chunks(original)[1]?.data as Buffer)).toBe(true);
  });

  it('keeps non-ASCII text intact (UTF-8)', () => {
    const baked = bakePng(makePng(), { name: 'Señal · 信号 ✓' });
    expect(JSON.parse(extractFromPng(baked) as string)).toEqual({ name: 'Señal · 信号 ✓' });
  });

  it('refuses to bake twice unless asked to replace, and never leaves two chunks', () => {
    const once = bakePng(makePng(), { id: 'first' });
    expect(() => bakePng(once, { id: 'second' })).toThrow(BakeError);
    const replaced = bakePng(once, { id: 'second' }, { replace: true });
    expect(chunks(replaced).filter((chunk) => chunk.type === 'iTXt')).toHaveLength(1);
    expect(JSON.parse(extractFromPng(replaced) as string)).toEqual({ id: 'second' });
  });

  it('stores a compact JWS as-is', () => {
    const jws = 'eyJhbGciOiJSUzI1NiJ9.eyJ2YyI6e319.c2ln';
    expect(extractFromPng(bakePng(makePng(), jws))).toBe(jws);
  });

  it('returns undefined for an unbaked PNG and ignores other text chunks', () => {
    expect(extractFromPng(makePng())).toBeUndefined();
    const comment = itxt('Comment', 0, Buffer.from('made with love'));
    const png = insertAfterHeader(makePng(), 'iTXt', comment);
    expect(extractFromPng(png)).toBeUndefined();
    const baked = bakePng(png, '{"id":"x"}');
    expect(extractFromPng(baked)).toBe('{"id":"x"}');
    expect(chunks(baked).filter((chunk) => chunk.type === 'iTXt')).toHaveLength(2);
  });

  it('reads a compressed iTXt chunk written by other tools', () => {
    const text = '{"id":"compressed"}';
    const data = itxt('openbadgecredential', 1, deflateSync(Buffer.from(text)));
    expect(extractFromPng(insertAfterHeader(makePng(), 'iTXt', data))).toBe(text);
  });

  it('rejects files that are not intact PNGs', () => {
    expect(() => extractFromPng(new TextEncoder().encode('GIF89a'))).toThrow(/Not a PNG/);
    const png = Buffer.from(makePng());
    expect(() => extractFromPng(png.subarray(0, png.length - 6))).toThrow(BakeError);
    const corrupted = Buffer.from(png);
    corrupted[20] = (corrupted[20] ?? 0) ^ 0xff; // inside IHDR
    expect(() => bakePng(corrupted, {})).toThrow(/checksum/);
  });
});

describe('SVG baking (OB 3.0 §5.3.2)', () => {
  const svg =
    '<?xml version="1.0" encoding="UTF-8"?>\n<!-- badge -->\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
    '<circle cx="256" cy="256" r="200" fill="#379392"/></svg>\n';

  it('round-trips a signed credential', async () => {
    const credential = await signedCredential();
    const baked = bakeSvg(svg, credential);
    expect(JSON.parse(extractFromSvg(baked) as string)).toEqual(credential);
  });

  it('declares the namespace and puts the credential right after <svg>', () => {
    const baked = bakeSvg(svg, { id: 'x' });
    expect(baked).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<!-- badge -->\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" ' +
        'xmlns:openbadges="https://purl.imsglobal.org/ob/v3p0">' +
        '<openbadges:credential><![CDATA[{"id":"x"}]]></openbadges:credential>' +
        '<circle cx="256" cy="256" r="200" fill="#379392"/></svg>\n',
    );
  });

  it('keeps "]]>" inside the credential intact', () => {
    const credential = { narrative: 'Arrays like a[b[0]]> are fine' };
    const baked = bakeSvg(svg, credential);
    expect(baked).toContain(']]]]><![CDATA[>');
    expect(JSON.parse(extractFromSvg(baked) as string)).toEqual(credential);
  });

  it('uses the verify attribute for a compact JWS', () => {
    const jws = 'eyJhbGciOiJSUzI1NiJ9.eyJ2YyI6e319.c2ln';
    const baked = bakeSvg(svg, jws);
    expect(baked).toContain(`<openbadges:credential verify="${jws}"></openbadges:credential>`);
    expect(extractFromSvg(baked)).toBe(jws);
  });

  it('refuses to bake twice unless asked to replace', () => {
    const once = bakeSvg(svg, { id: 'first' });
    expect(() => bakeSvg(once, { id: 'second' })).toThrow(BakeError);
    const replaced = bakeSvg(once, { id: 'second' }, { replace: true });
    expect(replaced.match(/<openbadges:credential/g)).toHaveLength(1);
    expect(replaced.match(/xmlns:openbadges=/g)).toHaveLength(1);
    expect(JSON.parse(extractFromSvg(replaced) as string)).toEqual({ id: 'second' });
  });

  it('extracts with any prefix bound to the namespace, and decodes entities', () => {
    const other =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:ob=\'https://purl.imsglobal.org/ob/v3p0\'>' +
      '<ob:credential>\n  {"name": "R&amp;D &#x2713; &#10003; &#x110000;"}\n</ob:credential><g/></svg>';
    expect(extractFromSvg(other)).toBe('{"name": "R&D ✓ ✓ &#x110000;"}');
  });

  it('handles a self-closing root and an unrelated openbadges prefix', () => {
    expect(extractFromSvg(bakeSvg('<svg xmlns="http://www.w3.org/2000/svg"/>', { a: 1 }))).toBe(
      '{"a":1}',
    );
    const clash = '<svg xmlns:openbadges="http://openbadges.org"></svg>';
    expect(() => bakeSvg(clash, {})).toThrow(/another namespace/);
  });

  it('returns undefined for an unbaked SVG and rejects non-SVG input', () => {
    expect(extractFromSvg(svg)).toBeUndefined();
    expect(() => extractFromSvg('<html></html>')).toThrow(/root element must be <svg>/);
  });
});

function itxt(keyword: string, compression: 0 | 1, text: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${keyword}\0`, 'latin1'),
    Buffer.of(compression, 0, 0, 0),
    text,
  ]);
}

/** Inserts a hand-built chunk after IHDR (IHDR is always 25 bytes: 13 of data plus 12). */
function insertAfterHeader(png: Uint8Array, type: string, data: Buffer): Uint8Array {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  const bytes = Buffer.from(png);
  return Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]);
}

// CRC-32 for hand-built test chunks.
function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}
