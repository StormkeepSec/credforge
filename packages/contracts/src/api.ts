import { z } from 'zod';
import { ORG_ROLES, type OrgRole, type Permission } from './roles';

// ---- shared vocabulary ----

/**
 * Organization lifecycle (design plan §6.3).
 * - `pending`: can set up and test-award to its own members; waits for a platform admin.
 * - `active`: approved (or created where approval isn't required).
 * - `suspended`: stopped by a platform admin; read-only, no issuing or email.
 * - `declined`: not approved; read-only.
 */
export const ORG_STATUSES = ['pending', 'active', 'suspended', 'declined'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const SIGNUP_MODES = ['approval', 'open', 'invite'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

/**
 * Where a signed-in session stands with the credforge second factor (§6.4).
 * - `ok`: nothing to do.
 * - `challenge`: the user has two-step verification but this session hasn't passed it (for
 *   example after Continue with Google). Enter a code first.
 * - `setup`: the user must turn on two-step verification first (owners and admins when
 *   `REQUIRE_MFA_FOR_ADMINS=true`).
 */
export type MfaState = 'ok' | 'challenge' | 'setup';

/** `code` values in RFC 9457 problem responses from `/api/v1`. */
export type ProblemCode =
  | 'unauthenticated'
  | 'email_not_verified'
  | 'mfa_required'
  | 'mfa_setup_required'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'org_inactive'
  | 'last_owner'
  | 'signup_closed'
  | 'invitation_invalid'
  | 'invitation_email_mismatch'
  | 'already_member'
  | 'bad_origin'
  | 'internal_error';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: ProblemCode;
  /** Field errors for `validation_failed`: dotted path → message. */
  errors?: Record<string, string>;
}

// ---- field rules ----

const text = (max: number) =>
  z.string().trim().min(1, 'Required').max(max, `At most ${max} characters`);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters`)
    .transform((value) => (value === '' ? null : value));

export const emailField = z
  .string()
  .trim()
  .max(254, 'At most 254 characters')
  .pipe(z.email('Enter a valid email address'))
  .transform((value) => value.toLowerCase());

/** An absolute http(s) URL, or empty for none. */
const optionalWebUrl = z
  .string()
  .trim()
  .max(2000, 'At most 2000 characters')
  .refine((value) => {
    if (value === '') return true;
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.');
    } catch {
      return false;
    }
  }, 'Enter a full web address, e.g. https://example.org')
  .transform((value) => (value === '' ? null : value));

const optionalEmail = z
  .string()
  .trim()
  .max(254, 'At most 254 characters')
  .refine(
    (value) => value === '' || z.email().safeParse(value).success,
    'Enter a valid email address',
  )
  .transform((value) => (value === '' ? null : value.toLowerCase()));

// ---- request bodies ----

export const createOrgInput = z.object({ name: text(120) });
export type CreateOrgInput = z.input<typeof createOrgInput>;

export const updateOrgInput = z.object({ name: text(120) });
export type UpdateOrgInput = z.input<typeof updateOrgInput>;

export const orgRoleField = z.enum(ORG_ROLES, { error: 'Choose a role' });

export const inviteMemberInput = z.object({ email: emailField, role: orgRoleField });
export type InviteMemberInput = z.input<typeof inviteMemberInput>;

export const updateMemberInput = z.object({ role: orgRoleField });
export type UpdateMemberInput = z.input<typeof updateMemberInput>;

export const issuerInput = z.object({
  name: text(200),
  url: optionalWebUrl.optional(),
  email: optionalEmail.optional(),
  description: optionalText(2000).optional(),
});
export type IssuerInputBody = z.input<typeof issuerInput>;

export const updateIssuerInput = issuerInput.partial();
export type UpdateIssuerInput = z.input<typeof updateIssuerInput>;

export const platformDecisionInput = z.object({ reason: optionalText(1000).optional() });
export type PlatformDecisionInput = z.input<typeof platformDecisionInput>;

export const platformOrgsQuery = z.object({ status: z.enum(ORG_STATUSES).optional() });

export const auditEventsQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---- responses ----

export interface InstanceInfo {
  signupMode: SignupMode;
  providers: { google: boolean; microsoft: boolean };
  requireMfaForAdmins: boolean;
}

export interface OrgSummary {
  id: string;
  name: string;
  status: OrgStatus;
  statusReason: string | null;
  createdAt: string;
}

export interface Membership {
  org: OrgSummary;
  role: OrgRole;
}

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  isPlatformAdmin: boolean;
  twoFactorEnabled: boolean;
}

/** `credential` (password), `google` or `microsoft`. */
export type SignInProvider = 'credential' | 'google' | 'microsoft' | (string & {});

export interface SignInMethod {
  /** The account id, for disconnecting it (Better Auth `unlinkAccount`). */
  id: string;
  provider: SignInProvider;
}

export interface MeResponse {
  user: CurrentUser;
  mfa: { state: MfaState; required: boolean };
  /** How this user can sign in. Turning on two-step verification asks for the password if there is one. */
  signInMethods: SignInMethod[];
  memberships: Membership[];
  /** Pending invitations to this user's verified email address. */
  invitations: InvitationForRecipient[];
}

export interface OrgDetails extends OrgSummary {
  role: OrgRole;
  permissions: Permission[];
  approvedAt: string | null;
}

export interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  twoFactorEnabled: boolean;
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: OrgRole;
  invitedBy: { id: string; name: string } | null;
  expiresAt: string;
  createdAt: string;
}

export interface InvitationForRecipient {
  id: string;
  org: { id: string; name: string };
  role: OrgRole;
  invitedByName: string | null;
  expiresAt: string;
}

/** What `/invite/{token}` shows before the person signs in. */
export interface InvitationPreview extends InvitationForRecipient {
  email: string;
}

export interface SigningKeySummary {
  id: string;
  algorithm: 'Ed25519';
  publicKeyMultibase: string;
  status: 'active' | 'retired' | 'revoked';
  createdAt: string;
}

export interface Issuer {
  id: string;
  /** The permanent issuer id embedded in credentials: `{PUBLIC_BASE_URL}/issuers/{id}`. */
  url: string;
  name: string;
  website: string | null;
  email: string | null;
  description: string | null;
  keys: SigningKeySummary[];
  createdAt: string;
  updatedAt: string;
}

export interface PlatformOrg extends OrgSummary {
  approvedAt: string | null;
  requestedBy: { name: string; email: string } | null;
  memberCount: number;
  issuers: { id: string; name: string; website: string | null }[];
}

export interface AuditEvent {
  id: number;
  action: string;
  actor: {
    type: 'user' | 'system' | 'api_key' | 'recipient';
    id: string | null;
    label: string | null;
  };
  target: { type: string; id: string } | null;
  data: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export interface AuditEventPage {
  events: AuditEvent[];
  /** Pass as `before` to get the next (older) page; null on the last page. */
  next: number | null;
}
