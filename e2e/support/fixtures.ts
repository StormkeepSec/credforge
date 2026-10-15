import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Test data for one run, written by tests/seed.setup.ts and read by the tests. Every run makes
 * new accounts with a generated password, so it never depends on (or touches) anyone's real
 * accounts in the development database. Stored in e2e/.auth/ (git-ignored).
 */
export interface RunFixtures {
  runId: string;
  /** Generated for this run; every seeded account uses it. */
  password: string;
  org: { id: string; name: string };
  /** Owner of `org`, with two-step verification on. */
  owner: { email: string; totpSecret: string };
  /** Platform admin, with two-step verification on. */
  admin: { email: string };
  /** Has an account and an open invitation to `org` (link: `inviteToken`). */
  invitee: { email: string };
  inviteToken: string;
  /** A second open invitation (no account) for tests that act on an invitation's row. */
  pendingInviteEmail: string;
  /** A published achievement with SVG artwork, and one credential awarded to the owner. */
  achievement: { id: string; name: string };
  credentialId: string;
}

const AUTH_DIR = resolve(import.meta.dirname, '../.auth');
const FIXTURES_FILE = join(AUTH_DIR, 'run.json');

/** Saved browser sessions (cookies) for the seeded accounts. */
export const SIGNED_IN = {
  owner: join(AUTH_DIR, 'owner.json'),
  admin: join(AUTH_DIR, 'admin.json'),
  invitee: join(AUTH_DIR, 'invitee.json'),
} as const;

export function newRunId(): string {
  return `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
}

export function generatePassword(): string {
  return `e2e-${randomBytes(18).toString('base64url')}`;
}

/** A fresh address for this run. `.test` is reserved, so nothing can ever be delivered there. */
export function testEmail(runId: string, who: string): string {
  return `e2e-${runId}-${who}@example.test`;
}

export function saveFixtures(fixtures: RunFixtures) {
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(FIXTURES_FILE, JSON.stringify(fixtures, null, 2));
}

/** Forgets the previous run's data, so nothing acts on it if this run's setup fails. */
export function clearFixtures() {
  rmSync(FIXTURES_FILE, { force: true });
}

export function hasFixtures(): boolean {
  return existsSync(FIXTURES_FILE);
}

let cached: RunFixtures | undefined;

export function fixtures(): RunFixtures {
  cached ??= JSON.parse(readFileSync(FIXTURES_FILE, 'utf8')) as RunFixtures;
  return cached;
}
