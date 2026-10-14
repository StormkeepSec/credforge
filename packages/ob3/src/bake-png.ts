import { crc32, inflateSync } from 'node:zlib';
import { PNG_KEYWORD } from './constants';

// Caps decompression of a (non-conforming) compressed chunk from an untrusted image.
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export class BakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BakeError';
  }
}

export interface BakeOptions {
  /**
   * What to do when the image already carries a credential: `false` (the default) throws, `true`
   * replaces it. OB 3.0 §5.3.1.1 allows either; an image must never carry two.
   */
  replace?: boolean;
}

interface Chunk {
  type: string;
  /** Offset of the chunk's length field. */
  start: number;
  /** Offset just past the chunk's CRC. */
  end: number;
  data: Uint8Array;
}

/**
 * Bakes a credential into a PNG (OB 3.0 §5.3.1): one uncompressed `iTXt` chunk with keyword
 * `openbadgecredential`, inserted right after `IHDR`. The image data is not re-encoded. Pass the
 * signed credential object (stored as compact JSON) or a VC-JWT compact JWS string.
 */
export function bakePng(
  png: Uint8Array,
  credential: object | string,
  options: BakeOptions = {},
): Uint8Array {
  const chunks = [...readChunks(png)];
  const header = chunks[0];
  if (header?.type !== 'IHDR') throw new BakeError('The PNG does not start with IHDR.');

  const existing = chunks.filter((chunk) => chunk.type === 'iTXt' && isCredentialChunk(chunk));
  if (existing.length > 0 && !options.replace) {
    throw new BakeError('The PNG already contains an Open Badges credential.');
  }

  const text = typeof credential === 'string' ? credential : JSON.stringify(credential);
  const parts: Uint8Array[] = [PNG_SIGNATURE, png.subarray(header.start, header.end)];
  parts.push(encodeChunk('iTXt', encodeITxt(PNG_KEYWORD, text)));
  for (const chunk of chunks.slice(1)) {
    if (!existing.includes(chunk)) parts.push(png.subarray(chunk.start, chunk.end));
  }
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * Extracts the baked credential from a PNG: the text of the first `iTXt` chunk with keyword
 * `openbadgecredential` (JSON or a compact JWS), or `undefined` if there is none.
 */
export function extractFromPng(png: Uint8Array): string | undefined {
  for (const chunk of readChunks(png)) {
    if (chunk.type !== 'iTXt') continue;
    const itxt = decodeITxt(chunk.data);
    if (itxt.keyword === PNG_KEYWORD) return itxt.text;
  }
  return undefined;
}

function* readChunks(png: Uint8Array): Generator<Chunk> {
  if (png.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((byte, i) => png[i] !== byte)) {
    throw new BakeError('Not a PNG image.');
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) throw new BakeError('The PNG is truncated.');
    const type = Buffer.from(png.subarray(offset + 4, dataStart)).toString('latin1');
    if (crc32(png.subarray(offset + 4, dataEnd)) !== view.getUint32(dataEnd)) {
      throw new BakeError(`The PNG ${type} chunk has a bad checksum.`);
    }
    yield { type, start: offset, end: dataEnd + 4, data: png.subarray(dataStart, dataEnd) };
    if (type === 'IEND') return;
    offset = dataEnd + 4;
  }
  throw new BakeError('The PNG has no IEND chunk.');
}

function encodeChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  chunk.set(data, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

// iTXt layout (PNG spec §11.3.4.5): keyword, NUL, compression flag, compression method,
// language tag, NUL, translated keyword, NUL, text. OB 3.0 forbids compression.
function encodeITxt(keyword: string, text: string): Uint8Array {
  return Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Uint8Array.of(0, 0, 0, 0, 0),
    Buffer.from(text, 'utf8'),
  ]);
}

function decodeITxt(data: Uint8Array) {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const keywordEnd = bytes.indexOf(0);
  if (keywordEnd < 1) throw new BakeError('The PNG has a malformed iTXt chunk.');
  const keyword = bytes.toString('latin1', 0, keywordEnd);
  const compressed = bytes[keywordEnd + 1] === 1;
  const languageEnd = bytes.indexOf(0, keywordEnd + 3);
  const translatedEnd = languageEnd === -1 ? -1 : bytes.indexOf(0, languageEnd + 1);
  if (translatedEnd === -1) throw new BakeError('The PNG has a malformed iTXt chunk.');
  const body = bytes.subarray(translatedEnd + 1);
  // Compression is not allowed when baking, but a lenient reader accepts it.
  const text = (
    compressed ? inflateSync(body, { maxOutputLength: MAX_TEXT_BYTES }) : body
  ).toString('utf8');
  return { keyword, text };
}

function isCredentialChunk(chunk: Chunk): boolean {
  const keywordEnd = chunk.data.indexOf(0);
  return Buffer.from(chunk.data.subarray(0, keywordEnd)).toString('latin1') === PNG_KEYWORD;
}
