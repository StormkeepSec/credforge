import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config';

/** Vite entry for the stylesheet shared by all server-rendered pages (apps/web/src/styles/public.css). */
const PUBLIC_CSS_ENTRY = 'src/styles/public.css';

export interface PublicAssets {
  stylesheet: string;
}

/**
 * Resolves asset URLs for server-rendered pages.
 * Production reads the hashed filename from the Vite manifest; development points at the
 * Vite dev server, which proxies page requests to this server (open http://localhost:5173).
 */
export function resolvePublicAssets(config: Pick<Config, 'env' | 'webDistDir'>): PublicAssets {
  if (config.env !== 'production') return { stylesheet: `/${PUBLIC_CSS_ENTRY}` };

  const manifestPath = join(config.webDistDir, '.vite', 'manifest.json');
  let manifest: Record<string, { file: string } | undefined>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error(`Web build not found at ${manifestPath}. Run \`pnpm build\` first.`);
  }
  const entry = manifest[PUBLIC_CSS_ENTRY];
  if (!entry) throw new Error(`${PUBLIC_CSS_ENTRY} is missing from ${manifestPath}.`);
  return { stylesheet: `/${entry.file}` };
}
