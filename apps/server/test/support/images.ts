import sharp from 'sharp';

/** A square PNG with EXIF metadata (camera, comment), as a phone might produce. */
export async function pngWithMetadata(size = 600, color = '#379392'): Promise<Buffer> {
  return sharp({ create: { width: size, height: size, channels: 4, background: color } })
    .withExif({ IFD0: { Make: 'TestCam', ImageDescription: 'secret location' } })
    .png()
    .toBuffer();
}

export async function jpeg(width = 800, height = 400): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#ca3cff' } })
    .withExif({ IFD0: { Make: 'TestCam' } })
    .jpeg()
    .toBuffer();
}

export const BADGE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <title>Network Defense</title>
  <circle cx="100" cy="100" r="90" fill="#111827"/>
  <path d="M100 30 L160 70 L140 160 L60 160 L40 70 Z" fill="#379392"/>
</svg>`;
