import { createHash } from 'node:crypto';
import sharp, { type OutputInfo, type Sharp } from 'sharp';
import { SvgError, sanitizeSvg } from './svg-sanitize';

/**
 * The image pipeline for badge images and issuer logos (design plan §5.4, §12).
 *
 * - Accepts PNG, SVG, JPEG and WebP up to 2 MB, recognized by their bytes, not by the name or
 *   the declared type.
 * - Raster images are decoded and re-encoded as PNG (lossless), which drops every bit of
 *   metadata (EXIF, location, comments); JPEG and WebP become PNG because OB 3.0 defines baking
 *   only for PNG and SVG. Anything larger than 2048 px is scaled down.
 * - SVGs are sanitized (svg-sanitize.ts) and must render.
 * - Derived PNGs: 512 px and 128 px squares (the image centered on transparency), and for badges
 *   a 1200×630 Open Graph card.
 */

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_DIMENSION = 2048;
/** Larger inputs are refused before decoding (a small file can claim a huge canvas). */
const MAX_INPUT_PIXELS = 40_000_000;

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'svg';

export class ImageError extends Error {
  constructor(
    readonly reason: 'too_large' | 'unsupported' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'ImageError';
  }
}

/** The file type from the leading bytes ("magic numbers"), or null if it isn't one we take. */
export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (
    b.length >= 12 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  // SVG is text: after an optional BOM, whitespace, XML declaration, comments and doctype, the
  // first element must be <svg>.
  const head = b
    .subarray(0, 4096)
    .toString('utf8')
    .replace(/^\uFEFF/, '');
  const rest = head
    .replace(/^\s*<\?xml[\s\S]*?\?>/, '')
    .replace(/^(?:\s*<!--[\s\S]*?-->)*/, '')
    .replace(/^\s*<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>/i, '')
    .replace(/^(?:\s*<!--[\s\S]*?-->)*/, '');
  if (/^\s*<(?:[A-Za-z_][\w.-]*:)?svg[\s>/]/.test(rest)) return 'svg';
  return null;
}

export interface ImageBytes {
  bytes: Buffer;
  mimeType: 'image/png' | 'image/svg+xml';
  width: number;
  height: number;
}

export type VariantName = '512' | '128' | 'og';

export interface ProcessedImage {
  /** Hex SHA-256 of the cleaned original: the content address in its URLs. */
  sha256: string;
  extension: 'png' | 'svg';
  original: ImageBytes;
  variants: Partial<Record<VariantName, ImageBytes>>;
}

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

export async function processImage(
  input: Buffer,
  options: { openGraph: boolean },
): Promise<ProcessedImage> {
  if (input.length === 0) throw new ImageError('invalid', 'The file is empty.');
  if (input.length > MAX_UPLOAD_BYTES) {
    throw new ImageError('too_large', 'The image is larger than 2 MB.');
  }
  const format = sniffImage(input);
  if (!format) {
    throw new ImageError('unsupported', 'Upload a PNG, SVG, JPEG or WebP image.');
  }

  let original: ImageBytes;
  /** What the derived PNGs are rendered from. */
  let render: (size: number) => Sharp;

  if (format === 'svg') {
    let svg: string;
    try {
      svg = sanitizeSvg(new TextDecoder('utf-8', { fatal: true }).decode(input)).svg;
    } catch (error) {
      if (error instanceof SvgError) throw new ImageError('invalid', error.message);
      if (error instanceof TypeError) {
        throw new ImageError('invalid', 'The SVG isn’t valid UTF-8 text.');
      }
      throw error;
    }
    const bytes = Buffer.from(svg, 'utf8');
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new ImageError('too_large', 'The image is larger than 2 MB.');
    }
    const meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .metadata()
      .catch(() => {
        throw new ImageError('invalid', 'The SVG couldn’t be drawn.');
      });
    if (!meta.width || !meta.height) {
      throw new ImageError('invalid', 'The SVG couldn’t be drawn.');
    }
    original = { bytes, mimeType: 'image/svg+xml', width: meta.width, height: meta.height };
    const longest = Math.max(meta.width, meta.height);
    // Rasterize at a density that draws the longest side at the target size, so it stays sharp.
    render = (size) =>
      sharp(bytes, {
        density: Math.min(Math.max((72 * size) / longest, 1), 2400),
        limitInputPixels: MAX_INPUT_PIXELS,
      });
  } else {
    let decoded: { data: Buffer; info: OutputInfo };
    try {
      decoded = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
        .rotate() // apply the EXIF orientation before metadata is dropped
        .resize({
          width: MAX_DIMENSION,
          height: MAX_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw new ImageError('invalid', 'The image couldn’t be read. It may be damaged.');
    }
    original = {
      bytes: decoded.data,
      mimeType: 'image/png',
      width: decoded.info.width,
      height: decoded.info.height,
    };
    const bytes = decoded.data;
    render = () => sharp(bytes);
  }

  const square = async (size: number): Promise<ImageBytes> => {
    const { data, info } = await render(size)
      .resize(size, size, { fit: 'contain', background: TRANSPARENT })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    return { bytes: data, mimeType: 'image/png', width: info.width, height: info.height };
  };

  const variants: ProcessedImage['variants'] = {
    '512': await square(512),
    '128': await square(128),
  };
  if (options.openGraph) variants.og = await openGraphCard(await square(440));

  return {
    sha256: createHash('sha256').update(original.bytes).digest('hex'),
    extension: format === 'svg' ? 'svg' : 'png',
    original,
    variants,
  };
}

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

/**
 * The link-preview card: the badge centered on a light canvas with credforge's angled accent
 * lines. It has no text, so it never goes stale when the achievement is renamed; the page's
 * `og:title` carries the name.
 */
async function openGraphCard(badge: ImageBytes): Promise<ImageBytes> {
  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#fafafa" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="#f1f3f5"/>
  <circle cx="600" cy="315" r="300" fill="url(#glow)"/>
  <path d="M0 0H210L90 ${OG_HEIGHT}H0Z" fill="#111827"/>
  <path d="M210 0H238L118 ${OG_HEIGHT}H90Z" fill="#379392"/>
  <path d="M${OG_WIDTH} ${OG_HEIGHT}H990L1110 0H${OG_WIDTH}Z" fill="#111827"/>
  <path d="M990 ${OG_HEIGHT}H962L1082 0H1110Z" fill="#CA3CFF"/>
</svg>`,
  );
  const { data, info } = await sharp(background)
    .composite([
      {
        input: badge.bytes,
        left: Math.round((OG_WIDTH - badge.width) / 2),
        top: Math.round((OG_HEIGHT - badge.height) / 2),
      },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  return { bytes: data, mimeType: 'image/png', width: info.width, height: info.height };
}
