import { exec, execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

/** The issuer app as `pnpm dev` serves it: Vite, which forwards the API to Fastify on :3000. */
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
export const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';
export const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** Whether `url` answers 2xx (`/readyz` through Vite needs both Vite and the API server). */
export async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/**
 * Runs pnpm in the repository root and returns its output. Uses the pnpm that started this run
 * (`npm_execpath`), so it works when pnpm is only available through corepack and not on PATH.
 * Arguments must not need shell quoting.
 */
export async function runPnpm(args: string[]): Promise<string> {
  const options = {
    cwd: REPO_ROOT,
    // The CLI reads the same development defaults as `pnpm dev`.
    env: { ...process.env, NODE_ENV: 'development' },
  };
  const entry = process.env.npm_execpath;
  const { stdout } =
    entry && /pnpm[^\\/]*\.c?js$/.test(entry)
      ? await promisify(execFile)(process.execPath, [entry, ...args], options)
      : await promisify(exec)(['pnpm', ...args].join(' '), options);
  return stdout;
}
