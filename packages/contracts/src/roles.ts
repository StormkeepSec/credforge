/**
 * Organization roles and the permissions they grant (design plan §3, item 3).
 *
 * Code checks permissions, never role names, so a role can be added or reshaped here without
 * touching the routes. The one exception is the owner role itself: only owners can grant or take
 * away ownership, and an organization always keeps at least one owner.
 */

export const ORG_ROLES = ['owner', 'admin', 'issuer', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PERMISSIONS = [
  'org:read',
  'org:update',
  'member:read',
  'member:invite',
  'member:manage',
  'issuer:read',
  'issuer:create',
  'issuer:update',
  'achievement:read',
  'achievement:write',
  'credential:read',
  'credential:issue',
  'credential:revoke',
  /** Download every credential with its recipient's address (CSV, JSONL). */
  'credential:export',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: readonly Permission[] = [
  'org:read',
  'member:read',
  'issuer:read',
  'achievement:read',
  'credential:read',
];

const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  // Creates achievements and awards them (M3/M4); can't change the org, its members or its issuer.
  issuer: [...READ, 'achievement:write', 'credential:issue', 'credential:revoke'],
  viewer: READ,
};

export const ROLE_LABELS: Record<OrgRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  issuer: 'Issuer',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<OrgRole, string> = {
  owner: 'Everything, including granting and removing ownership.',
  admin: 'Manages the organization, its issuer profile and its members (except owners).',
  issuer: 'Creates achievements and awards badges.',
  viewer: 'Read-only access.',
};

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

export function permissionsFor(role: OrgRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Roles that must pass a credforge second factor when `REQUIRE_MFA_FOR_ADMINS=true` (§6.4). */
export const PRIVILEGED_ROLES: readonly OrgRole[] = ['owner', 'admin'];

/** Roles an actor may hand out, by invitation or role change. Only owners can create owners. */
export function assignableRoles(actorRole: OrgRole): readonly OrgRole[] {
  if (actorRole === 'owner') return ORG_ROLES;
  if (roleHasPermission(actorRole, 'member:manage')) return ['admin', 'issuer', 'viewer'];
  return [];
}

/**
 * Whether `actorRole` may change a member from `currentRole` to `newRole` (or remove them, when
 * `newRole` is undefined). Keeping at least one owner is checked separately, against the database.
 */
export function canManageMember(
  actorRole: OrgRole,
  currentRole: OrgRole,
  newRole?: OrgRole,
): boolean {
  if (!roleHasPermission(actorRole, 'member:manage')) return false;
  if (actorRole === 'owner') return true;
  if (currentRole === 'owner') return false;
  return newRole === undefined || assignableRoles(actorRole).includes(newRole);
}
