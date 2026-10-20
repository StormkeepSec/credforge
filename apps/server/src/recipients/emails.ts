import { createHash, randomBytes } from 'node:crypto';
import { type AccountEmail, MAX_EXTRA_EMAILS } from '@credforge/contracts';
import { and, type Database, eq, type Queryable, user, userEmail } from '@credforge/db';
import { ApiError, conflict, notFound } from '../api/errors';
import { type AuditRequestInfo, recordAudit } from '../audit/audit';
import { confirmAddressMessage } from '../email/messages';
import type { EmailOutbox } from '../email/outbox';
import { normalizeEmail } from './addresses';

/**
 * Extra addresses on an account, for My badges (design plan §8.8, decision 52). Each is confirmed
 * by a link emailed to it, opened while signed in to the same account: the link alone isn't
 * enough, so someone who adds another person's address can't get it confirmed by them.
 */

/** Confirmation links work for a day, like credforge's sign-up confirmation. */
const LINK_HOURS = 24;
/** Sending a new link to the same address waits this long. */
export const RESEND_WAIT_MS = 60_000;

type EmailRow = typeof userEmail.$inferSelect;

export interface EmailServices {
  db: Database;
  outbox: EmailOutbox;
  publicBaseUrl: string;
  /** Called once a confirmation email is about to go out; throws to refuse it (rate limit). */
  beforeSend: () => void;
}

export interface AccountActor {
  user: { id: string; email: string };
}

export function hashConfirmationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newConfirmation(now: Date) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashConfirmationToken(token),
    tokenExpiresAt: new Date(now.getTime() + LINK_HOURS * 60 * 60 * 1000),
    sentAt: now,
  };
}

export function confirmationUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl}/confirm-email?token=${token}`;
}

export function serializeAccountEmail(row: EmailRow): AccountEmail {
  return {
    id: row.id,
    email: row.email,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAccountEmails(db: Database, userId: string): Promise<AccountEmail[]> {
  const rows = await db
    .select()
    .from(userEmail)
    .where(eq(userEmail.userId, userId))
    .orderBy(userEmail.createdAt);
  return rows.map(serializeAccountEmail);
}

const auditAccount = (
  db: Queryable,
  actor: AccountActor,
  action: string,
  email: string,
  request: AuditRequestInfo,
) =>
  recordAudit(db, {
    actor: { type: 'user', id: actor.user.id, label: actor.user.email },
    action,
    target: { type: 'user', id: actor.user.id },
    data: { email },
    request,
  });

/** Adds an address and emails it a confirmation link. */
export async function addAccountEmail(
  services: EmailServices,
  actor: AccountActor,
  email: string,
  request: AuditRequestInfo,
): Promise<AccountEmail> {
  const { db } = services;
  const address = normalizeEmail(email);
  if (address === normalizeEmail(actor.user.email)) {
    throw new ApiError(
      409,
      'conflict',
      'Already your address',
      'This is the address you sign in with.',
    );
  }
  const now = new Date();
  const confirmation = newConfirmation(now);
  const row = await db.transaction(async (tx) => {
    // One request at a time per account, so the cap holds.
    await tx.select({ id: user.id }).from(user).where(eq(user.id, actor.user.id)).for('update');
    const existing = await tx
      .select({ email: userEmail.email })
      .from(userEmail)
      .where(eq(userEmail.userId, actor.user.id));
    if (existing.some((item) => item.email === address)) {
      throw conflict('This address is already on your account.');
    }
    if (existing.length >= MAX_EXTRA_EMAILS) {
      throw conflict(`You can add up to ${MAX_EXTRA_EMAILS} addresses. Remove one first.`);
    }
    services.beforeSend();
    const [inserted] = await tx
      .insert(userEmail)
      .values({
        userId: actor.user.id,
        email: address,
        tokenHash: confirmation.tokenHash,
        tokenExpiresAt: confirmation.tokenExpiresAt,
        sentAt: confirmation.sentAt,
      })
      .returning();
    if (!inserted) throw new Error('Insert returned no row.');
    await auditAccount(tx, actor, 'user.email_added', address, request);
    return inserted;
  });
  await services.outbox.send(
    confirmAddressMessage(address, confirmationUrl(services.publicBaseUrl, confirmation.token)),
  );
  return serializeAccountEmail(row);
}

/** A new confirmation link for an address that isn't confirmed yet; earlier links stop working. */
export async function resendAccountEmail(
  services: EmailServices,
  actor: AccountActor,
  id: string,
): Promise<AccountEmail> {
  const { db } = services;
  const [row] = await db
    .select()
    .from(userEmail)
    .where(and(eq(userEmail.id, id), eq(userEmail.userId, actor.user.id)));
  if (!row) throw notFound('Address');
  if (row.verifiedAt) throw conflict('This address is already confirmed.');
  const now = new Date();
  const wait = (row.sentAt?.getTime() ?? 0) + RESEND_WAIT_MS - now.getTime();
  if (wait > 0) {
    throw new ApiError(
      429,
      'rate_limited',
      'Just sent',
      `A link was sent less than a minute ago. Try again in ${Math.ceil(wait / 1000)} seconds.`,
    );
  }
  services.beforeSend();
  const confirmation = newConfirmation(now);
  const [updated] = await db
    .update(userEmail)
    .set({
      tokenHash: confirmation.tokenHash,
      tokenExpiresAt: confirmation.tokenExpiresAt,
      sentAt: confirmation.sentAt,
      updatedAt: now,
    })
    .where(eq(userEmail.id, row.id))
    .returning();
  if (!updated) throw notFound('Address');
  await services.outbox.send(
    confirmAddressMessage(row.email, confirmationUrl(services.publicBaseUrl, confirmation.token)),
  );
  return serializeAccountEmail(updated);
}

const invalidLink = () =>
  new ApiError(
    400,
    'email_confirmation_invalid',
    'This link doesn’t work',
    'It has expired, a newer one was sent, or it belongs to another account. Sign in to the account that added the address, then send a new link from Account settings.',
  );

/**
 * Confirms the address whose link this is. The link must belong to the signed-in account;
 * otherwise, as for an unknown or expired link, nothing is said about whose it is.
 */
export async function confirmAccountEmail(
  db: Database,
  actor: AccountActor,
  token: string,
  request: AuditRequestInfo,
): Promise<AccountEmail> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(userEmail)
      .where(eq(userEmail.tokenHash, hashConfirmationToken(token)))
      .for('update');
    if (
      !row ||
      row.userId !== actor.user.id ||
      row.verifiedAt ||
      !row.tokenExpiresAt ||
      row.tokenExpiresAt <= now
    ) {
      throw invalidLink();
    }
    const [updated] = await tx
      .update(userEmail)
      .set({ verifiedAt: now, tokenHash: null, tokenExpiresAt: null, updatedAt: now })
      .where(eq(userEmail.id, row.id))
      .returning();
    if (!updated) throw invalidLink();
    await auditAccount(tx, actor, 'user.email_confirmed', row.email, request);
    return serializeAccountEmail(updated);
  });
}

export async function removeAccountEmail(
  db: Database,
  actor: AccountActor,
  id: string,
  request: AuditRequestInfo,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(userEmail)
      .where(and(eq(userEmail.id, id), eq(userEmail.userId, actor.user.id)))
      .returning({ email: userEmail.email });
    if (!deleted) throw notFound('Address');
    await auditAccount(tx, actor, 'user.email_removed', deleted.email, request);
  });
}
