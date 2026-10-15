import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ImageError, MAX_UPLOAD_BYTES, processImage, sniffImage } from '../src/files/images';
import { BADGE_SVG, jpeg, pngWithMetadata } from './support/images';

describe('sniffImage', () => {
  it('recognizes files by their bytes', async () => {
    expect(sniffImage(await pngWithMetadata(16))).toBe('png');
    expect(sniffImage(await jpeg(16, 16))).toBe('jpeg');
    expect(
      sniffImage(
        await sharp(await pngWithMetadata(16))
          .webp()
          .toBuffer(),
      ),
    ).toBe('webp');
    expect(sniffImage(Buffer.from(BADGE_SVG))).toBe('svg');
    expect(sniffImage(Buffer.from(`﻿<!-- c -->\n<svg xmlns="http://www.w3.org/2000/svg"/>`))).toBe(
      'svg',
    );
  });

  it('refuses everything else, whatever it is called', async () => {
    expect(sniffImage(Buffer.from('<html><svg></svg></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a...'))).toBeNull();
    expect(
      sniffImage(
        await sharp(await pngWithMetadata(16))
          .gif()
          .toBuffer(),
      ),
    ).toBeNull();
    expect(sniffImage(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('processImage', () => {
  it('re-encodes raster images as PNG without metadata, with square variants', async () => {
    const result = await processImage(await jpeg(800, 400), { openGraph: true });
    expect(result.extension).toBe('png');
    expect(result.original).toMatchObject({ mimeType: 'image/png', width: 800, height: 400 });
    const meta = await sharp(result.original.bytes).metadata();
    expect(meta.format).toBe('png');
    expect(meta.exif).toBeUndefined();
    expect(result.variants['512']).toMatchObject({ width: 512, height: 512 });
    expect(result.variants['128']).toMatchObject({ width: 128, height: 128 });
    expect(result.variants.og).toMatchObject({ width: 1200, height: 630 });
    // Letterboxed on transparency, not stretched.
    const corner = await sharp(result.variants['512']?.bytes)
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect(corner[3]).toBe(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('scales down anything larger than 2048 px', async () => {
    const big = await sharp({
      create: { width: 3000, height: 1500, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    const result = await processImage(big, { openGraph: false });
    expect([result.original.width, result.original.height]).toEqual([2048, 1024]);
    expect(result.variants.og).toBeUndefined();
  });

  it('keeps cleaned SVG as SVG and renders its variants sharply', async () => {
    const result = await processImage(Buffer.from(BADGE_SVG), { openGraph: true });
    expect(result.extension).toBe('svg');
    expect(result.original.mimeType).toBe('image/svg+xml');
    expect(result.original.bytes.toString()).toContain('<circle');
    expect(result.variants['512']).toMatchObject({ width: 512, height: 512 });
  });

  it('gives the same address to the same image', async () => {
    const png = await pngWithMetadata(64);
    const [a, b] = await Promise.all([
      processImage(png, { openGraph: false }),
      processImage(png, { openGraph: false }),
    ]);
    expect(a.sha256).toBe(b.sha256);
  });

  it('refuses unsupported, damaged, empty and oversized files', async () => {
    const reason = async (input: Buffer) =>
      processImage(input, { openGraph: false }).then(
        () => 'accepted',
        (error: unknown) => (error instanceof ImageError ? error.reason : String(error)),
      );
    expect(await reason(Buffer.from('hello'))).toBe('unsupported');
    expect(await reason(Buffer.alloc(0))).toBe('invalid');
    expect(await reason(Buffer.alloc(MAX_UPLOAD_BYTES + 1))).toBe('too_large');
    const png = await pngWithMetadata(64);
    expect(await reason(png.subarray(0, 40))).toBe('invalid');
    expect(await reason(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>'))).toBe(
      'invalid',
    );
    expect(await reason(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('invalid');
  });

  it('refuses images with an enormous canvas before decoding them', async () => {
    const huge = await sharp({
      create: { width: 7000, height: 7000, channels: 3, background: '#000' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(huge.length).toBeLessThan(MAX_UPLOAD_BYTES);
    await expect(processImage(huge, { openGraph: false })).rejects.toMatchObject({
      reason: 'invalid',
    });
  });
});
