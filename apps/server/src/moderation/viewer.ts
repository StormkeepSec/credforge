import { and, eq, member } from '@credforge/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { resolveAuth } from '../api/auth-context';
import { mayHaveSession } from '../recipients/ownership';
import type { Services } from '../services';

/**
 * Whether the visitor is signed in (and ready) as a member of the org: they see the org's content
 * that is waiting for review, in the issuer app and at its public image URLs (design plan §6.5).
 */
export async function isOrgMember(
  services: Pick<Services, 'auth' | 'db' | 'config'>,
  request: FastifyRequest,
  reply: FastifyReply,
  orgId: string,
): Promise<boolean> {
  if (!mayHaveSession(request)) return false;
  const context = await resolveAuth(services, request, reply);
  if (!context?.user.emailVerified || context.mfa.state !== 'ok') return false;
  const [row] = await services.db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.orgId, orgId), eq(member.userId, context.user.id)))
    .limit(1);
  return row !== undefined;
}
