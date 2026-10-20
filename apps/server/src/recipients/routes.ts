import {
  type AccountEmail,
  addEmailInput,
  confirmEmailInput,
  type RecipientCredential,
  type RecipientCredentialPage,
  recipientCredentialsQuery,
  updateRecipientCredentialInput,
} from '@credforge/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { requireReadySession } from '../api/auth-context';
import { ApiError, notFound, parse, uuidParam } from '../api/errors';
import { createRateLimiter } from '../api/rate-limit';
import { parseCursor } from '../credentials/routes';
import { requestInfo } from '../orgs/access';
import type { Services } from '../services';
import { confirmedAddresses } from './addresses';
import {
  addAccountEmail,
  confirmAccountEmail,
  listAccountEmails,
  removeAccountEmail,
  resendAccountEmail,
} from './emails';
import {
  changeVisibility,
  findRecipientCredential,
  listRecipientCredentials,
  loadRecipientCredential,
} from './service';

/** Confirmation emails one account may have sent in an hour (adding and sending again). */
const CONFIRMATION_EMAILS_PER_HOUR = 10;

/**
 * My badges (design plan §8.8): `/api/v1/me/credentials` and `/api/v1/me/emails`. They belong to
 * the person signed in, not to an org: recipients needn't be members of anything, and API keys
 * never reach them (`requireSession` refuses a request that carries one). Every query is scoped
 * to the account's confirmed addresses, so one person never sees another's badges.
 */
export const recipientRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const { db, config, outbox } = services;
  const confirmationLimiter = createRateLimiter({
    max: CONFIRMATION_EMAILS_PER_HOUR,
    windowMs: 60 * 60_000,
  });

  async function signedIn(request: FastifyRequest, reply: FastifyReply) {
    const context = await requireReadySession(services, request, reply);
    return { context, addresses: await confirmedAddresses(db, context.user) };
  }

  const credentialIdOf = (request: FastifyRequest) =>
    uuidParam((request.params as { credentialId?: string }).credentialId, 'Badge');
  const emailIdOf = (request: FastifyRequest) =>
    uuidParam((request.params as { emailId?: string }).emailId, 'Address');

  /** What sending confirmation emails needs, counting each one against the account's limit. */
  const emailServices = (userId: string, reply: FastifyReply) => ({
    db,
    outbox,
    publicBaseUrl: config.publicBaseUrl,
    beforeSend() {
      const limit = confirmationLimiter.take(`confirm-address:${userId}`);
      if (!limit.allowed) {
        reply.header('retry-after', String(limit.retryAfter));
        throw new ApiError(
          429,
          'rate_limited',
          'Too many confirmation emails',
          `Try again in ${Math.ceil(limit.retryAfter / 60)} minutes.`,
        );
      }
    },
  });

  app.get('/me/credentials', async (request, reply): Promise<RecipientCredentialPage> => {
    const { addresses } = await signedIn(request, reply);
    const query = parse(recipientCredentialsQuery, request.query);
    return listRecipientCredentials(db, config.publicBaseUrl, addresses, {
      before: parseCursor(query.before),
      limit: query.limit,
    });
  });

  app.get('/me/credentials/:credentialId', async (request, reply): Promise<RecipientCredential> => {
    const { addresses } = await signedIn(request, reply);
    const row = await findRecipientCredential(db, addresses, credentialIdOf(request));
    if (!row) throw notFound('Badge');
    return loadRecipientCredential(db, config.publicBaseUrl, row);
  });

  /** Hide the badge's public page, or make it public again (as with the claim link). */
  app.patch(
    '/me/credentials/:credentialId',
    async (request, reply): Promise<RecipientCredential> => {
      const { addresses } = await signedIn(request, reply);
      const input = parse(updateRecipientCredentialInput, request.body);
      const row = await findRecipientCredential(db, addresses, credentialIdOf(request));
      if (!row) throw notFound('Badge');
      await changeVisibility(db, row, input.visibility, request);
      return loadRecipientCredential(db, config.publicBaseUrl, {
        ...row,
        visibility: input.visibility,
      });
    },
  );

  app.get('/me/emails', async (request, reply): Promise<{ emails: AccountEmail[] }> => {
    const { context } = await signedIn(request, reply);
    return { emails: await listAccountEmails(db, context.user.id) };
  });

  app.post('/me/emails', async (request, reply) => {
    const { context } = await signedIn(request, reply);
    const input = parse(addEmailInput, request.body);
    const created = await addAccountEmail(
      emailServices(context.user.id, reply),
      context,
      input.email,
      requestInfo(request),
    );
    return reply.code(201).send(created);
  });

  app.post('/me/emails/confirm', async (request, reply): Promise<AccountEmail> => {
    const { context } = await signedIn(request, reply);
    const input = parse(confirmEmailInput, request.body);
    return confirmAccountEmail(db, context, input.token, requestInfo(request));
  });

  app.post('/me/emails/:emailId/resend', async (request, reply): Promise<AccountEmail> => {
    const { context } = await signedIn(request, reply);
    return resendAccountEmail(emailServices(context.user.id, reply), context, emailIdOf(request));
  });

  app.delete('/me/emails/:emailId', async (request, reply) => {
    const { context } = await signedIn(request, reply);
    await removeAccountEmail(db, context, emailIdOf(request), requestInfo(request));
    return reply.code(204).send();
  });
};
