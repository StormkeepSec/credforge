import { type Database, eq, session, twoFactor, user } from '@credforge/db';
import { type AuditActor, recordAudit } from '../audit/audit';
import { hasPrivilegedRole } from './mfa';

export type TwoFactorReset =
  | { outcome: 'no_account' }
  | { outcome: 'not_on' }
  | {
      outcome: 'reset';
      userId: string;
      /** Sessions ended: every browser signs in again. */
      sessionsEnded: number;
      /** It was locked after too many wrong codes. */
      wasLocked: boolean;
      /** They must set it up again at their next sign-in (privileged, REQUIRE_MFA_FOR_ADMINS). */
      setupRequired: boolean;
    };

/**
 * Turns two-step verification off for someone who can no longer pass it (lost phone and backup
 * codes, or an entry that never matched this instance): the operator's `cli.js reset-two-factor`
 * (design plan §6.4, decision 55). Deletes the TOTP secret and backup codes (which also clears a
 * lockout), turns the account's flag off and ends its sessions, in one transaction with an audit
 * event that holds no secrets. The password and other sign-in methods stay.
 */
export async function resetTwoFactor(
  db: Database,
  input: { email: string; requireMfaForAdmins: boolean; actor: AuditActor },
): Promise<TwoFactorReset> {
  const result = await db.transaction(async (tx) => {
    const [account] = await tx
      .select({ id: user.id, email: user.email, twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.email, input.email))
      .for('update');
    if (!account) return { outcome: 'no_account' } as const;
    const [secret] = await tx
      .select({ verified: twoFactor.verified, lockedUntil: twoFactor.lockedUntil })
      .from(twoFactor)
      .where(eq(twoFactor.userId, account.id));
    // An unconfirmed row is a setup that was started and not finished: nothing to recover from.
    if (!account.twoFactorEnabled && !secret?.verified) return { outcome: 'not_on' } as const;

    const wasLocked = secret?.lockedUntil != null && secret.lockedUntil.getTime() > Date.now();
    await tx.delete(twoFactor).where(eq(twoFactor.userId, account.id));
    await tx
      .update(user)
      .set({ twoFactorEnabled: false, updatedAt: new Date() })
      .where(eq(user.id, account.id));
    const ended = await tx
      .delete(session)
      .where(eq(session.userId, account.id))
      .returning({ id: session.id });
    await recordAudit(tx, {
      actor: input.actor,
      action: 'user.two_factor_reset',
      target: { type: 'user', id: account.id },
      data: { email: account.email, sessionsEnded: ended.length, wasLocked },
    });
    return {
      outcome: 'reset',
      userId: account.id,
      sessionsEnded: ended.length,
      wasLocked,
    } as const;
  });
  if (result.outcome !== 'reset') return result;

  const [account] = await db
    .select({ isPlatformAdmin: user.isPlatformAdmin })
    .from(user)
    .where(eq(user.id, result.userId));
  const setupRequired =
    input.requireMfaForAdmins &&
    (Boolean(account?.isPlatformAdmin) || (await hasPrivilegedRole(db, result.userId)));
  return { ...result, setupRequired };
}

/** What `cli.js reset-two-factor` prints: what was done and what happens at the next sign-in. */
export function describeTwoFactorReset(email: string, result: TwoFactorReset): string {
  switch (result.outcome) {
    case 'no_account':
      return `No account uses ${email}. Check the address the person signs in with.`;
    case 'not_on':
      return `Two-step verification isn't on for ${email}. Nothing changed.`;
    case 'reset': {
      const sessions =
        result.sessionsEnded === 1 ? '1 session' : `${result.sessionsEnded} sessions`;
      const lines = [
        `Two-step verification is off for ${email}: its authenticator secret and backup codes are deleted${result.wasLocked ? ', the lockout after wrong codes is cleared' : ''}, and ${sessions} ended.`,
        'The entry for this site in their authenticator app no longer works; they can delete it.',
      ];
      if (result.setupRequired) {
        lines.push(
          'They are an owner, admin or platform admin and this instance requires two-step verification (REQUIRE_MFA_FOR_ADMINS=true): at their next sign-in they must set it up again, with a new QR code, before doing anything else.',
        );
      } else {
        lines.push(
          'They sign in as usual, without a code, and can turn two-step verification on again in Account settings.',
        );
      }
      return lines.join('\n');
    }
  }
}
