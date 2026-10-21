import sharp from 'sharp';
import type { VariantName } from '../files/images';

/**
 * Neutral images served in place of held or removed ones (design plan §6.5): a grey tile with a
 * clock ("waiting for review") or a crossed-out picture ("removed"). They have no text, so no
 * font is needed and nothing needs translating; the page around them and their alt text say what
 * they mean.
 */

export type PlaceholderKind = 'held' | 'removed';

const TILE = '#E5E7EB';
const INK = '#6B7280';

const GLYPHS: Record<PlaceholderKind, string> = {
  held: `<circle cx="256" cy="256" r="120" fill="none" stroke="${INK}" stroke-width="28"/>
  <path d="M256 180v84l58 38" fill="none" stroke="${INK}" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/>`,
  removed: `<rect x="136" y="160" width="240" height="192" rx="24" fill="none" stroke="${INK}" stroke-width="24"/>
  <path d="M168 320l64-72 48 48 32-32 48 56" fill="none" stroke="${INK}" stroke-width="20" stroke-linejoin="round"/>
  <circle cx="314" cy="210" r="20" fill="${INK}"/>
  <path d="M128 392 384 120" stroke="${TILE}" stroke-width="60" stroke-linecap="round"/>
  <path d="M128 392 384 120" stroke="${INK}" stroke-width="28" stroke-linecap="round"/>`,
};

/** The placeholder as SVG (served at `.svg` image URLs). */
export function placeholderSvg(kind: PlaceholderKind): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="96" fill="${TILE}"/>
  ${GLYPHS[kind]}
</svg>
`;
}

type Size = VariantName | 'original';

const cache = new Map<string, Promise<Buffer>>();

async function render(kind: PlaceholderKind, size: Size): Promise<Buffer> {
  const svg = Buffer.from(placeholderSvg(kind));
  if (size === 'og') {
    const tile = await sharp(svg, { density: 72 * (440 / 512) })
      .resize(440, 440)
      .png()
      .toBuffer();
    return sharp({
      create: { width: 1200, height: 630, channels: 4, background: '#F1F3F5' },
    })
      .composite([{ input: tile, left: 380, top: 95 }])
      .png({ compressionLevel: 9 })
      .toBuffer();
  }
  const pixels = size === '128' ? 128 : 512;
  return sharp(svg, { density: 72 * (pixels / 512) })
    .resize(pixels, pixels)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** The placeholder as PNG at a variant's size (the original's URL gets the 512 px one). */
export function placeholderPng(kind: PlaceholderKind, size: Size): Promise<Buffer> {
  const key = `${kind}:${size}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = render(kind, size);
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return pending;
}
