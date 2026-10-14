import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * In development, loads overrides from the repo-root `.env.development` if it exists.
 * Variables already set in the environment win. Never runs in production.
 */
export function loadDevEnvFile(): void {
  if ((process.env.NODE_ENV ?? 'development') !== 'development') return;
  const file = resolve(import.meta.dirname, '../../../.env.development');
  if (existsSync(file)) process.loadEnvFile(file);
}
