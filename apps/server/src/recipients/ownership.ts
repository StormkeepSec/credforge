import type { FastifyReply, FastifyRequest } from 'fastify';
import { resolveAuth } from '../api/auth-context';
import type { CredentialRow } from '../credentials/service';
import type { Services } from '../services';
import { confirmedAddresses } from './addresses';

/** Better Auth's session cookie (`cookiePrefix: 'credforge'`), `__Secure-` on HTTPS. */
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?credforge\.session_token=/;

/**
 * Whether the request may be signed in by its cookies: it carries a session cookie and no
 * Authorization header (as in the API, a request with one is never signed in by cookies).
 * Public pages check this first, so visitors without a session cost no lookup.
 */
export function mayHaveSession(request: FastifyRequest): boolean {
  return !request.headers.authorization && SESSION_COOKIE.test(request.headers.cookie ?? '');
}

/**
 * Who is looking at a badge's public page, as far as accounts go (design plan §8.8):
 *
 * - `owner`: signed in, ready (email verified, second factor passed where needed), with the
 *   address the badge was awarded to among the account's confirmed addresses. They see a hidden
 *   page, its downloads, and the recipient's actions, as with the claim link.
 * - `other`: signed in and ready, but the badge's address isn't confirmed on this account.
 * - `null`: not signed in (or the session isn't ready yet).
 *
 * Visitors without a session cookie cost no lookup.
 */
export type AccountView = 'owner' | 'other' | null;

export async function accountView(
  services: Pick<Services, 'auth' | 'db' | 'config'>,
  request: FastifyRequest,
  reply: FastifyReply,
  row: Pick<CredentialRow, 'recipientEmail'>,
): Promise<AccountView> {
  if (!mayHaveSession(request)) return null;
  const context = await resolveAuth(services, request, reply);
  if (!context?.user.emailVerified || context.mfa.state !== 'ok') return null;
  const addresses = await confirmedAddresses(services.db, context.user);
  return row.recipientEmail && addresses.includes(row.recipientEmail) ? 'owner' : 'other';
}
