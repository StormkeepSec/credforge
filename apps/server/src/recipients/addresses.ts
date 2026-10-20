import {
  and,
  credential,
  eq,
  gt,
  inArray,
  invitation,
  isNotNull,
  isNull,
  type Queryable,
  userEmail,
} from '@credforge/db';

/** Addresses are compared as awards store them: trimmed and lowercase (`emailField`). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The addresses whose badges an account may see in My badges (design plan §8.8, decision 52):
 *
 * - its own address, once it is verified. Better Auth sets `emailVerified` only after
 *   credforge's confirmation email, Google's `email_verified`, or Microsoft's `xms_edov` (§6.4);
 * - each extra address confirmed through the link emailed to it, opened while signed in.
 *
 * An account whose own address isn't verified gets none at all: otherwise anyone could sign up
 * with someone else's address and read their badges.
 */
export async function confirmedAddresses(
  db: Queryable,
  user: { id: string; email: string; emailVerified: boolean },
): Promise<string[]> {
  if (!user.emailVerified) return [];
  const extras = await db
    .select({ email: userEmail.email })
    .from(userEmail)
    .where(and(eq(userEmail.userId, user.id), isNotNull(userEmail.verifiedAt)))
    .orderBy(userEmail.createdAt);
  return [...new Set([normalizeEmail(user.email), ...extras.map((row) => row.email)])];
}

/** Credentials a recipient sees: awarded (valid, expired or revoked), never erased tombstones. */
export function recipientCredentialConditions(addresses: string[]) {
  return and(
    inArray(credential.recipientEmail, addresses),
    isNull(credential.erasedAt),
    isNotNull(credential.document),
    inArray(credential.status, ['issued', 'revoked']),
  );
}

/**
 * SIGNUP_MODE=invite (decision 53): an address may create an account when it has an open
 * invitation, or when a badge was awarded to it here, so recipients can always use My badges.
 * Strangers still can't, and Better Auth answers their sign-up like any other (no enumeration).
 */
export async function mayCreateAccountByInvitation(db: Queryable, email: string): Promise<boolean> {
  const address = normalizeEmail(email);
  const [pending] = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(invitation.email, address),
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (pending) return true;
  const [awarded] = await db
    .select({ id: credential.id })
    .from(credential)
    .where(recipientCredentialConditions([address]))
    .limit(1);
  return Boolean(awarded);
}
