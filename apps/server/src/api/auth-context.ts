import type { MfaState } from '@credforge/contracts';
import type { Database } from '@credforge/db';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from '../auth/auth';
import { hasPrivilegedRole, mfaState } from '../auth/mfa';
import type { Config } from '../config';
import { ApiError } from './errors';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  isPlatformAdmin: boolean;
  twoFactorEnabled: boolean;
}

export interface AuthContext {
  user: SessionUser;
  session: { id: string; mfaVerifiedAt: Date | null };
  mfa: { state: MfaState; required: boolean };
}

export interface AuthResolverDeps {
  auth: Auth;
  db: Database;
  config: Pick<Config, 'requireMfaForAdmins'>;
}

const cache = new WeakMap<FastifyRequest, Promise<AuthContext | null>>();

/**
 * The signed-in user for this request, or null. Resolved once per request. Refreshed session
 * cookies from Better Auth are passed on to the response.
 */
export function resolveAuth(
  deps: AuthResolverDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthContext | null> {
  let pending = cache.get(request);
  if (!pending) {
    pending = load(deps, request, reply);
    cache.set(request, pending);
  }
  return pending;
}

async function load(
  { auth, db, config }: AuthResolverDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthContext | null> {
  if (!request.headers.cookie) return null;
  const { headers, response } = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
    returnHeaders: true,
  });
  const cookies = headers?.getSetCookie?.() ?? [];
  if (cookies.length > 0) reply.header('set-cookie', cookies);
  if (!response) return null;

  const u = response.user as typeof response.user & {
    isPlatformAdmin?: boolean | null;
    twoFactorEnabled?: boolean | null;
  };
  const s = response.session as typeof response.session & { mfaVerifiedAt?: Date | string | null };
  const user: SessionUser = {
    id: u.id,
    name: u.name,
    email: u.email,
    emailVerified: u.emailVerified,
    image: u.image ?? null,
    isPlatformAdmin: u.isPlatformAdmin === true,
    twoFactorEnabled: u.twoFactorEnabled === true,
  };
  const mfaVerifiedAt = s.mfaVerifiedAt ? new Date(s.mfaVerifiedAt) : null;
  const required =
    config.requireMfaForAdmins && (user.isPlatformAdmin || (await hasPrivilegedRole(db, user.id)));
  return {
    user,
    session: { id: s.id, mfaVerifiedAt },
    mfa: {
      required,
      state: mfaState({
        required,
        twoFactorEnabled: user.twoFactorEnabled,
        sessionVerified: mfaVerifiedAt !== null,
      }),
    },
  };
}

/** Any signed-in session, whatever its email or second-factor state. */
export async function requireSession(
  deps: AuthResolverDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthContext> {
  // A request with an Authorization header (an API key) is never authenticated by its cookies:
  // that is what lets /api/v1 skip its Origin check for such requests (api/v1.ts).
  if (request.headers.authorization) {
    throw new ApiError(
      401,
      'unauthenticated',
      'Sign in first',
      'This endpoint needs a signed-in person, not an API key.',
    );
  }
  const context = await resolveAuth(deps, request, reply);
  if (!context) throw new ApiError(401, 'unauthenticated', 'Sign in first');
  return context;
}

/**
 * A session that may use the app: email verified, and the credforge second factor passed where
 * it is needed (design plan §6.4).
 */
export async function requireReadySession(
  deps: AuthResolverDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthContext> {
  const context = await requireSession(deps, request, reply);
  if (!context.user.emailVerified) {
    throw new ApiError(403, 'email_not_verified', 'Confirm your email address first');
  }
  if (context.mfa.state === 'challenge') {
    throw new ApiError(
      403,
      'mfa_required',
      'Two-step verification needed',
      'Enter a code from your authenticator app to continue.',
    );
  }
  if (context.mfa.state === 'setup') {
    throw new ApiError(
      403,
      'mfa_setup_required',
      'Turn on two-step verification',
      'Owners and admins must use two-step verification on this instance.',
    );
  }
  return context;
}
