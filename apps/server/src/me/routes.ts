import type { InstanceInfo, MeResponse } from '@credforge/contracts';
import { account, asc, eq, member, organization } from '@credforge/db';
import type { FastifyPluginAsync } from 'fastify';
import { requireSession } from '../api/auth-context';
import { invitationsForEmail } from '../orgs/invitations';
import { serializeOrgSummary } from '../orgs/service';
import type { Services } from '../services';

/** `/api/v1/instance` (public) and `/api/v1/me` (any signed-in session). */
export const meRoutes: FastifyPluginAsync<{ services: Services }> = async (app, { services }) => {
  const { db, config } = services;

  /** What the sign-in and sign-up screens need to know about this instance. */
  app.get(
    '/instance',
    async (): Promise<InstanceInfo> => ({
      signupMode: config.signupMode,
      providers: {
        google: Boolean(config.oauth.google),
        microsoft: Boolean(config.oauth.microsoft),
      },
      requireMfaForAdmins: config.requireMfaForAdmins,
    }),
  );

  /**
   * The signed-in user, their memberships and where their session stands. Works before email
   * verification and before the second factor, so the app can send people to the right screen.
   */
  app.get('/me', async (request, reply): Promise<MeResponse> => {
    const context = await requireSession(services, request, reply);
    const ready = context.user.emailVerified && context.mfa.state === 'ok';
    const memberships = ready
      ? await db
          .select({ role: member.role, org: organization })
          .from(member)
          .innerJoin(organization, eq(member.orgId, organization.id))
          .where(eq(member.userId, context.user.id))
          .orderBy(asc(organization.name))
      : [];
    const methods = await db
      .select({ id: account.id, provider: account.providerId })
      .from(account)
      .where(eq(account.userId, context.user.id))
      .orderBy(asc(account.createdAt));
    return {
      user: context.user,
      mfa: context.mfa,
      signInMethods: methods,
      memberships: memberships.map((row) => ({
        role: row.role,
        org: serializeOrgSummary(row.org),
      })),
      invitations: ready ? await invitationsForEmail(db, context.user.email) : [],
    };
  });
};
