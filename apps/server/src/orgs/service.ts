import type { OrgDetails, OrgRole, OrgSummary } from '@credforge/contracts';
import {
  and,
  type Database,
  eq,
  member,
  organization,
  type Queryable,
  sql,
  user,
} from '@credforge/db';
import type { OrgAccess } from './access';

type OrgRow = Pick<
  typeof organization.$inferSelect,
  'id' | 'name' | 'status' | 'statusReason' | 'createdAt'
>;

export function serializeOrgSummary(row: OrgRow): OrgSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    statusReason: row.statusReason,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeOrgDetails(
  access: Pick<OrgAccess, 'org' | 'permissions'> & { member: { role: OrgRole } },
  defaultDailySendLimit: number,
): OrgDetails {
  return {
    ...serializeOrgSummary(access.org),
    approvedAt: access.org.approvedAt?.toISOString() ?? null,
    role: access.member.role,
    permissions: [...access.permissions],
    dailySendLimit: effectiveDailySendLimit(access.org.dailySendLimit, defaultDailySendLimit),
  };
}

/**
 * The award emails an org may send in any 24 hours: its own limit if a platform admin set one,
 * otherwise the instance default. Null means no limit (a limit of 0).
 */
export function effectiveDailySendLimit(
  orgLimit: number | null,
  defaultLimit: number,
): number | null {
  const limit = orgLimit ?? defaultLimit;
  return limit === 0 ? null : limit;
}

/**
 * Locks the org row for the rest of the transaction. Membership changes take this lock first, so
 * two owners demoting each other at the same moment can't leave the org without an owner.
 */
export async function lockOrg(tx: Queryable, orgId: string): Promise<void> {
  await tx.execute(
    sql`select id from ${organization} where ${organization.id} = ${orgId} for update`,
  );
}

export async function countOwners(tx: Queryable, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(member)
    .where(and(eq(member.orgId, orgId), eq(member.role, 'owner')));
  return row?.count ?? 0;
}

/** Owners' addresses, for approval and suspension notices. */
export async function ownerEmails(db: Database, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ email: user.email })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(and(eq(member.orgId, orgId), eq(member.role, 'owner')));
  return rows.map((row) => row.email);
}

export async function platformAdminEmails(db: Database): Promise<string[]> {
  const rows = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.isPlatformAdmin, true));
  return rows.map((row) => row.email);
}
