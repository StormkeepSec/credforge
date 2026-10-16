import { describe, expect, it } from 'vitest';
import {
  assignableRoles,
  canManageMember,
  ORG_ROLES,
  PERMISSIONS,
  permissionsFor,
  roleHasPermission,
} from '../src/roles';

describe('role permissions', () => {
  it('gives owners and admins every permission', () => {
    expect(permissionsFor('owner')).toEqual(PERMISSIONS);
    expect(permissionsFor('admin')).toEqual(PERMISSIONS);
  });

  it('lets issuers award but not manage the org', () => {
    expect(roleHasPermission('issuer', 'credential:issue')).toBe(true);
    expect(roleHasPermission('issuer', 'achievement:write')).toBe(true);
    expect(roleHasPermission('issuer', 'issuer:update')).toBe(false);
    expect(roleHasPermission('issuer', 'member:invite')).toBe(false);
    expect(roleHasPermission('issuer', 'audit:read')).toBe(false);
    expect(roleHasPermission('issuer', 'recipient:erase')).toBe(false);
  });

  it('keeps viewers read-only', () => {
    for (const permission of permissionsFor('viewer')) expect(permission).toMatch(/:read$/);
    expect(roleHasPermission('viewer', 'audit:read')).toBe(false);
  });

  it('gives every role read access to the org', () => {
    for (const role of ORG_ROLES) expect(roleHasPermission(role, 'org:read')).toBe(true);
  });
});

describe('role assignment', () => {
  it('lets only owners hand out ownership', () => {
    expect(assignableRoles('owner')).toContain('owner');
    expect(assignableRoles('admin')).not.toContain('owner');
    expect(assignableRoles('issuer')).toEqual([]);
    expect(assignableRoles('viewer')).toEqual([]);
  });

  it('stops admins from changing or removing owners', () => {
    expect(canManageMember('admin', 'owner', 'viewer')).toBe(false);
    expect(canManageMember('admin', 'owner')).toBe(false);
    expect(canManageMember('admin', 'issuer', 'owner')).toBe(false);
    expect(canManageMember('admin', 'issuer', 'admin')).toBe(true);
    expect(canManageMember('admin', 'viewer')).toBe(true);
  });

  it('lets owners change anyone', () => {
    expect(canManageMember('owner', 'owner', 'viewer')).toBe(true);
    expect(canManageMember('owner', 'admin')).toBe(true);
  });

  it('stops issuers and viewers from managing members', () => {
    expect(canManageMember('issuer', 'viewer', 'issuer')).toBe(false);
    expect(canManageMember('viewer', 'viewer')).toBe(false);
  });
});
