import type { FastifyReply, FastifyRequest } from 'fastify';
import { type AuthContext, requireReadySession } from '../api/auth-context';
import { forbidden } from '../api/errors';
import type { Services } from '../services';

/** The signed-in platform admin, or 403. */
export async function requirePlatformAdmin(
  services: Pick<Services, 'auth' | 'db' | 'config'>,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthContext> {
  const actor = await requireReadySession(services, request, reply);
  if (!actor.user.isPlatformAdmin) throw forbidden('Only platform admins can do this.');
  return actor;
}
