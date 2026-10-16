import {
  achievementInput,
  achievementRevisionSchema,
  achievementSchema,
  achievementsQuery,
  apiKeySchema,
  auditEventPageSchema,
  auditEventsQuery,
  awardInput,
  awardPreviewInput,
  awardPreviewSchema,
  BATCH_LIMITS,
  batchCsvQuery,
  batchDetailsSchema,
  batchesQuery,
  batchPageSchema,
  batchRowPageSchema,
  batchRowsQuery,
  bulkRevokeInput,
  bulkRevokeResultSchema,
  createApiKeyInput,
  createBatchFromRowsInput,
  createdApiKeySchema,
  createOrgInput,
  credentialDetailsSchema,
  credentialFilters,
  credentialPageSchema,
  credentialsQuery,
  domainCheckResultSchema,
  domainVerificationSchema,
  instanceInfoSchema,
  invitationPreviewSchema,
  invitationSchema,
  inviteMemberInput,
  issuerInput,
  issuerSchema,
  memberSchema,
  meResponseSchema,
  orgDetailsSchema,
  type Permission,
  platformDecisionInput,
  platformOrgLimitsInput,
  platformOrgSchema,
  platformOrgsQuery,
  problemSchema,
  recipientErasurePreviewSchema,
  recipientErasureResultSchema,
  reissueInput,
  revokeInput,
  updateAchievementInput,
  updateBatchInput,
  updateIssuerInput,
  updateMemberInput,
  updateOrgInput,
  verifyInput,
  verifyResultSchema,
} from '@credforge/contracts';
import { z } from 'zod';

/**
 * Every `/api/v1` operation, in one table. It is the source of the OpenAPI document served at
 * `/api/v1/openapi.json` (shown at `/api/docs`), and it decides which operations API keys may
 * call (`apiKey: true`): everything else needs a person signed in. A test checks that every
 * registered route has exactly one entry here.
 */
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type OperationAuth =
  /** Anyone; no cookies are used. */
  | { kind: 'public' }
  /** A person signed in (email confirmed, second factor passed where required). */
  | { kind: 'session' }
  /** A platform admin. */
  | { kind: 'platform' }
  /** A member of the org in the path with this permission, or (when `apiKey`) one of its keys. */
  | { kind: 'org'; permission: Permission | null; apiKey: boolean };

export interface OperationResponse {
  status: number;
  description: string;
  schema?: z.ZodType;
  /** Defaults to `application/json` when there is a schema. */
  contentType?: string;
}

export interface Operation {
  method: Method;
  /** Relative to `/api/v1`, with `{param}` path parameters. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  auth: OperationAuth;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Raw request bodies, by content type (uploads). */
  rawBody?: { contentTypes: string[]; description: string };
  responses: OperationResponse[];
}

const PUBLIC: OperationAuth = { kind: 'public' };
const SESSION: OperationAuth = { kind: 'session' };
const PLATFORM: OperationAuth = { kind: 'platform' };
const key = (permission: Permission): OperationAuth => ({ kind: 'org', permission, apiKey: true });
const member = (permission: Permission | null): OperationAuth => ({
  kind: 'org',
  permission,
  apiKey: false,
});

const ok = (schema: z.ZodType, description = 'OK'): OperationResponse => ({
  status: 200,
  description,
  schema,
});
const created = (schema: z.ZodType, description = 'Created'): OperationResponse => ({
  status: 201,
  description,
  schema,
});
const noContent = (description = 'Done'): OperationResponse => ({ status: 204, description });
const file = (contentType: string, description: string): OperationResponse => ({
  status: 200,
  description,
  contentType,
});

const IMAGE_UPLOAD = {
  contentTypes: ['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'],
  description:
    'The image itself as the request body, up to 2 MB. JPEG and WebP become PNG; SVGs are sanitized.',
};

const orgStatusChange = z.object({
  id: z.uuid(),
  status: z.string(),
  statusReason: z.string().nullable(),
});

const ISSUERS = 'Issuers';
const ACHIEVEMENTS = 'Achievements';
const CREDENTIALS = 'Awarded badges';
const BATCHES = 'Batches';
const EXPORTS = 'Exports';
const VERIFY = 'Verify';
const ORGS = 'Organizations';
const MEMBERS = 'Members and invitations';
const KEYS = 'API keys';
const AUDIT = 'Audit log';
const ACCOUNT = 'Account';
const PLATFORM_TAG = 'Platform';

export const OPERATIONS: readonly Operation[] = [
  // ---- account and instance ----
  {
    method: 'GET',
    path: '/instance',
    tag: ACCOUNT,
    summary: 'How this instance signs people up',
    auth: PUBLIC,
    responses: [ok(instanceInfoSchema)],
  },
  {
    method: 'GET',
    path: '/me',
    tag: ACCOUNT,
    summary: 'The signed-in person, their sign-in methods and memberships',
    auth: SESSION,
    responses: [ok(meResponseSchema)],
  },

  // ---- organizations ----
  {
    method: 'POST',
    path: '/orgs',
    tag: ORGS,
    summary: 'Create an organization',
    description:
      'With `SIGNUP_MODE=approval` it starts as `pending` until a platform admin approves it.',
    auth: SESSION,
    body: createOrgInput,
    responses: [created(orgDetailsSchema)],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}',
    tag: ORGS,
    summary: 'The organization, with your role and permissions',
    auth: member(null),
    responses: [ok(orgDetailsSchema)],
  },
  {
    method: 'PATCH',
    path: '/orgs/{orgId}',
    tag: ORGS,
    summary: 'Rename the organization',
    auth: member('org:update'),
    body: updateOrgInput,
    responses: [ok(orgDetailsSchema)],
  },

  // ---- members and invitations ----
  {
    method: 'GET',
    path: '/orgs/{orgId}/members',
    tag: MEMBERS,
    summary: 'List members',
    auth: member('member:read'),
    responses: [ok(z.object({ members: z.array(memberSchema) }))],
  },
  {
    method: 'PATCH',
    path: '/orgs/{orgId}/members/{memberId}',
    tag: MEMBERS,
    summary: 'Change a member’s role',
    auth: member('member:manage'),
    body: updateMemberInput,
    responses: [ok(z.object({ id: z.uuid(), role: z.string() }))],
  },
  {
    method: 'DELETE',
    path: '/orgs/{orgId}/members/{memberId}',
    tag: MEMBERS,
    summary: 'Remove a member, or leave (your own member id)',
    auth: member(null),
    responses: [noContent()],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}/invitations',
    tag: MEMBERS,
    summary: 'List open invitations',
    auth: member('member:invite'),
    responses: [ok(z.object({ invitations: z.array(invitationSchema) }))],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/invitations',
    tag: MEMBERS,
    summary: 'Invite someone by email',
    auth: member('member:invite'),
    body: inviteMemberInput,
    responses: [created(invitationSchema)],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/invitations/{invitationId}/resend',
    tag: MEMBERS,
    summary: 'Send an invitation again with a new link',
    auth: member('member:invite'),
    responses: [ok(z.object({ id: z.uuid(), expiresAt: z.string() }))],
  },
  {
    method: 'DELETE',
    path: '/orgs/{orgId}/invitations/{invitationId}',
    tag: MEMBERS,
    summary: 'Withdraw an invitation',
    auth: member('member:invite'),
    responses: [noContent()],
  },
  {
    method: 'GET',
    path: '/invitations/{token}',
    tag: MEMBERS,
    summary: 'Preview an invitation from its link',
    auth: PUBLIC,
    responses: [ok(invitationPreviewSchema)],
  },
  {
    method: 'POST',
    path: '/invitations/{token}/accept',
    tag: MEMBERS,
    summary: 'Accept an invitation from its link',
    auth: SESSION,
    responses: [
      ok(z.object({ org: z.object({ id: z.uuid(), name: z.string() }), role: z.string() })),
    ],
  },
  {
    method: 'POST',
    path: '/me/invitations/{invitationId}/accept',
    tag: MEMBERS,
    summary: 'Accept an invitation to your confirmed address',
    auth: SESSION,
    responses: [
      ok(z.object({ org: z.object({ id: z.uuid(), name: z.string() }), role: z.string() })),
    ],
  },

  // ---- API keys ----
  {
    method: 'GET',
    path: '/orgs/{orgId}/api-keys',
    tag: KEYS,
    summary: 'List API keys (including revoked ones)',
    auth: member('api_key:manage'),
    responses: [ok(z.object({ apiKeys: z.array(apiKeySchema) }))],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/api-keys',
    tag: KEYS,
    summary: 'Create an API key',
    description:
      'The response holds the whole key. It is never shown again; only its hash is kept.',
    auth: member('api_key:manage'),
    body: createApiKeyInput,
    responses: [created(createdApiKeySchema)],
  },
  {
    method: 'DELETE',
    path: '/orgs/{orgId}/api-keys/{keyId}',
    tag: KEYS,
    summary: 'Revoke an API key',
    description: 'It stops working at once. The key stays listed as revoked.',
    auth: member('api_key:manage'),
    responses: [noContent('Revoked')],
  },

  // ---- issuers ----
  {
    method: 'GET',
    path: '/orgs/{orgId}/issuers',
    tag: ISSUERS,
    summary: 'List issuer profiles',
    auth: key('issuer:read'),
    responses: [ok(z.object({ issuers: z.array(issuerSchema) }))],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/issuers',
    tag: ISSUERS,
    summary: 'Create an issuer profile (with its signing key)',
    auth: member('issuer:create'),
    body: issuerInput,
    responses: [created(issuerSchema)],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}/issuers/{issuerId}',
    tag: ISSUERS,
    summary: 'Get an issuer profile',
    auth: key('issuer:read'),
    responses: [ok(issuerSchema)],
  },
  {
    method: 'PATCH',
    path: '/orgs/{orgId}/issuers/{issuerId}',
    tag: ISSUERS,
    summary: 'Change an issuer profile',
    description: 'Badges already awarded keep the profile they were signed with.',
    auth: member('issuer:update'),
    body: updateIssuerInput,
    responses: [ok(issuerSchema)],
  },
  {
    method: 'PUT',
    path: '/orgs/{orgId}/issuers/{issuerId}/logo',
    tag: ISSUERS,
    summary: 'Upload the issuer’s logo',
    auth: member('issuer:update'),
    rawBody: IMAGE_UPLOAD,
    responses: [ok(issuerSchema)],
  },
  {
    method: 'DELETE',
    path: '/orgs/{orgId}/issuers/{issuerId}/logo',
    tag: ISSUERS,
    summary: 'Remove the issuer’s logo',
    auth: member('issuer:update'),
    responses: [ok(issuerSchema)],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/issuers/{issuerId}/domain-verification',
    tag: ISSUERS,
    summary: 'Get the DNS record or file that verifies the website’s domain',
    auth: member('issuer:update'),
    responses: [ok(domainVerificationSchema)],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/issuers/{issuerId}/domain-verification/check',
    tag: ISSUERS,
    summary: 'Check the DNS record or file now',
    auth: member('issuer:update'),
    responses: [ok(domainCheckResultSchema)],
  },

  // ---- achievements ----
  {
    method: 'GET',
    path: '/orgs/{orgId}/achievements',
    tag: ACHIEVEMENTS,
    summary: 'List achievements',
    auth: key('achievement:read'),
    query: achievementsQuery,
    responses: [ok(z.object({ achievements: z.array(achievementSchema) }))],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/achievements',
    tag: ACHIEVEMENTS,
    summary: 'Create an achievement (a draft)',
    auth: key('achievement:write'),
    body: achievementInput,
    responses: [created(achievementSchema)],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}/achievements/{achievementId}',
    tag: ACHIEVEMENTS,
    summary: 'Get an achievement',
    auth: key('achievement:read'),
    responses: [ok(achievementSchema)],
  },
  {
    method: 'PATCH',
    path: '/orgs/{orgId}/achievements/{achievementId}',
    tag: ACHIEVEMENTS,
    summary: 'Change an achievement',
    description: 'A change to a signed field adds a revision. Badges already awarded don’t change.',
    auth: key('achievement:write'),
    body: updateAchievementInput,
    responses: [ok(achievementSchema)],
  },
  {
    method: 'DELETE',
    path: '/orgs/{orgId}/achievements/{achievementId}',
    tag: ACHIEVEMENTS,
    summary: 'Delete a draft achievement',
    auth: key('achievement:write'),
    responses: [noContent('Deleted')],
  },
  {
    method: 'PUT',
    path: '/orgs/{orgId}/achievements/{achievementId}/image',
    tag: ACHIEVEMENTS,
    summary: 'Upload the badge image',
    auth: key('achievement:write'),
    rawBody: IMAGE_UPLOAD,
    responses: [ok(achievementSchema)],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/achievements/{achievementId}/publish',
    tag: ACHIEVEMENTS,
    summary: 'Publish a draft so it can be awarded',
    auth: key('achievement:write'),
    responses: [ok(achievementSchema)],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/achievements/{achievementId}/archive',
    tag: ACHIEVEMENTS,
    summary: 'Stop awarding an achievement (its page stays up)',
    auth: key('achievement:write'),
    responses: [ok(achievementSchema)],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/achievements/{achievementId}/restore',
    tag: ACHIEVEMENTS,
    summary: 'Award an archived achievement again',
    auth: key('achievement:write'),
    responses: [ok(achievementSchema)],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}/achievements/{achievementId}/revisions',
    tag: ACHIEVEMENTS,
    summary: 'List an achievement’s revisions',
    auth: key('achievement:read'),
    responses: [ok(z.object({ revisions: z.array(achievementRevisionSchema) }))],
  },

  // ---- awarded badges ----
  {
    method: 'GET',
    path: '/orgs/{orgId}/credentials',
    tag: CREDENTIALS,
    summary: 'Search awarded badges (newest first)',
    auth: key('credential:read'),
    query: credentialsQuery,
    responses: [ok(credentialPageSchema)],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/credentials',
    tag: CREDENTIALS,
    summary: 'Award a badge to one person',
    description:
      'Signs an Open Badges 3.0 credential and, unless `sendEmail` is false, emails the recipient their claim link. Counts against the daily email cap.',
    auth: key('credential:issue'),
    body: awardInput,
    responses: [created(credentialDetailsSchema)],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/credentials/preview',
    tag: CREDENTIALS,
    summary: 'What the award email would say (signs nothing)',
    auth: key('credential:issue'),
    body: awardPreviewInput,
    responses: [ok(awardPreviewSchema)],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}/credentials/{credentialId}',
    tag: CREDENTIALS,
    summary: 'Get an awarded badge, its signed credential and its emails',
    auth: key('credential:read'),
    responses: [ok(credentialDetailsSchema)],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/credentials/{credentialId}/resend',
    tag: CREDENTIALS,
    summary: 'Email the claim link again (a new link; the old one stops working)',
    auth: key('credential:issue'),
    responses: [ok(credentialDetailsSchema)],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/credentials/{credentialId}/revoke',
    tag: CREDENTIALS,
    summary: 'Revoke a badge',
    description: 'Its status list is re-signed a few seconds later.',
    auth: key('credential:revoke'),
    body: revokeInput,
    responses: [ok(credentialDetailsSchema)],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/credentials/revoke',
    tag: CREDENTIALS,
    summary: 'Revoke up to 500 badges',
    auth: key('credential:revoke'),
    body: bulkRevokeInput,
    responses: [ok(bulkRevokeResultSchema)],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/credentials/{credentialId}/reissue',
    tag: CREDENTIALS,
    summary: 'Replace a badge with a corrected copy',
    description:
      'Needs `credential:issue` and `credential:revoke`. The old badge is revoked as superseded.',
    auth: key('credential:issue'),
    body: reissueInput,
    responses: [created(credentialDetailsSchema)],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}/credentials/{credentialId}/erasure',
    tag: CREDENTIALS,
    summary: 'What erasing this badge’s recipient would cover',
    description:
      'Every badge the organization awarded to the same email address, the badges linked to those by a reissue, and the CSV rows holding the address.',
    auth: member('recipient:erase'),
    responses: [ok(recipientErasurePreviewSchema)],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/credentials/{credentialId}/erasure',
    tag: CREDENTIALS,
    summary: 'Erase the recipient’s data (can’t be undone)',
    description:
      'Revokes the badges that are still valid (they stay revoked: copies keep verifying as revoked), removes the signed credentials, the name and email address from badges, emails and CSV rows, deletes the uploaded CSV files, and makes what the audit log says about the person unreadable. The badges’ pages answer 410 Gone. 409 `already_erased` when nothing is left to erase.',
    auth: member('recipient:erase'),
    responses: [ok(recipientErasureResultSchema)],
  },

  // ---- batches ----
  {
    method: 'GET',
    path: '/orgs/{orgId}/batches',
    tag: BATCHES,
    summary: 'List batches (newest first)',
    auth: key('credential:read'),
    query: batchesQuery,
    responses: [ok(batchPageSchema)],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}/batches/template.csv',
    tag: BATCHES,
    summary: 'A CSV template',
    auth: key('credential:read'),
    responses: [file('text/csv', 'The template')],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/batches',
    tag: BATCHES,
    summary: 'Upload a CSV file or JSON rows (a draft)',
    description: `Send a CSV file as the raw body (\`Content-Type: text/csv\`, with \`achievementId\` and an optional \`fileName\` in the query), or JSON rows. Up to ${BATCH_LIMITS.maxRows.toLocaleString('en-US')} rows and 5 MB. Nothing is awarded until the batch is confirmed.`,
    auth: key('credential:issue'),
    query: batchCsvQuery.partial(),
    body: createBatchFromRowsInput,
    rawBody: { contentTypes: ['text/csv'], description: 'The CSV file' },
    responses: [created(batchDetailsSchema)],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}/batches/{batchId}',
    tag: BATCHES,
    summary: 'Get a batch, its counts and what confirming would do',
    auth: key('credential:read'),
    responses: [ok(batchDetailsSchema)],
  },
  {
    method: 'PATCH',
    path: '/orgs/{orgId}/batches/{batchId}',
    tag: BATCHES,
    summary: 'Change a draft batch: columns, header line, options',
    auth: key('credential:issue'),
    body: updateBatchInput,
    responses: [ok(batchDetailsSchema)],
  },
  {
    method: 'DELETE',
    path: '/orgs/{orgId}/batches/{batchId}',
    tag: BATCHES,
    summary: 'Discard a draft batch',
    auth: key('credential:issue'),
    responses: [noContent('Discarded')],
  },
  {
    method: 'POST',
    path: '/orgs/{orgId}/batches/{batchId}/confirm',
    tag: BATCHES,
    summary: 'Award the batch',
    description:
      'Refused with 429 `send_limit_reached` when its emails would pass the daily cap; nothing is half sent.',
    auth: key('credential:issue'),
    responses: [ok(batchDetailsSchema)],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}/batches/{batchId}/rows',
    tag: BATCHES,
    summary: 'A batch’s rows and the problems found in them',
    auth: key('credential:read'),
    query: batchRowsQuery,
    responses: [ok(batchRowPageSchema)],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}/batches/{batchId}/results.csv',
    tag: BATCHES,
    summary: 'Each row’s result as CSV',
    auth: key('credential:read'),
    responses: [file('text/csv', 'Results')],
  },

  // ---- exports and audit ----
  {
    method: 'GET',
    path: '/orgs/{orgId}/exports/credentials.csv',
    tag: EXPORTS,
    summary: 'Export awarded badges as CSV',
    auth: key('credential:export'),
    query: credentialFilters,
    responses: [file('text/csv', 'Streamed CSV')],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}/exports/credentials.jsonl',
    tag: EXPORTS,
    summary: 'Export awarded badges as JSON Lines, with the signed credentials',
    auth: key('credential:export'),
    query: credentialFilters,
    responses: [file('application/jsonl', 'Streamed JSON Lines')],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}/exports/audit-events.csv',
    tag: EXPORTS,
    summary: 'Export the audit log as CSV',
    auth: key('audit:read'),
    responses: [file('text/csv', 'Streamed CSV')],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}/exports/audit-events.jsonl',
    tag: EXPORTS,
    summary: 'Export the audit log as JSON Lines',
    auth: key('audit:read'),
    responses: [file('application/jsonl', 'Streamed JSON Lines')],
  },
  {
    method: 'GET',
    path: '/orgs/{orgId}/audit-events',
    tag: AUDIT,
    summary: 'Read the audit log (newest first)',
    auth: key('audit:read'),
    query: auditEventsQuery,
    responses: [ok(auditEventPageSchema)],
  },

  // ---- verify ----
  {
    method: 'POST',
    path: '/verify',
    tag: VERIFY,
    summary: 'Verify an Open Badges 3.0 credential',
    description:
      'Give a URL, the credential’s JSON, or a baked PNG/SVG (base64, or the raw body with `Content-Type: image/png` or `image/svg+xml`). Nothing about the request is stored. Rate limited per client IP.',
    auth: PUBLIC,
    body: verifyInput,
    rawBody: { contentTypes: ['image/png', 'image/svg+xml'], description: 'A baked badge image' },
    responses: [ok(verifyResultSchema)],
  },

  // ---- platform ----
  {
    method: 'GET',
    path: '/platform/orgs',
    tag: PLATFORM_TAG,
    summary: 'Organizations, by status',
    auth: PLATFORM,
    query: platformOrgsQuery,
    responses: [ok(z.object({ orgs: z.array(platformOrgSchema) }))],
  },
  ...(['approve', 'decline', 'suspend', 'reinstate'] as const).map(
    (action): Operation => ({
      method: 'POST',
      path: `/platform/orgs/{orgId}/${action}`,
      tag: PLATFORM_TAG,
      summary: `${action[0]?.toUpperCase()}${action.slice(1)} an organization`,
      auth: PLATFORM,
      body: platformDecisionInput,
      responses: [ok(orgStatusChange)],
    }),
  ),
  {
    method: 'PATCH',
    path: '/platform/orgs/{orgId}/limits',
    tag: PLATFORM_TAG,
    summary: 'Set an organization’s daily email cap',
    auth: PLATFORM,
    body: platformOrgLimitsInput,
    responses: [
      ok(
        z.object({
          id: z.uuid(),
          dailySendLimit: z.number().int().nullable(),
          defaultDailySendLimit: z.number().int(),
        }),
      ),
    ],
  },
];

/** `/api/v1/orgs/:orgId/x` → `/orgs/{orgId}/x`. */
export function openApiPath(fastifyUrl: string): string {
  const path = fastifyUrl.replace(/^\/api\/v1/, '').replace(/:(\w+)/g, '{$1}');
  return path.length > 1 ? path.replace(/\/$/, '') : '/';
}

const byRoute = new Map(OPERATIONS.map((op) => [`${op.method} ${op.path}`, op]));

export function operationFor(method: string, fastifyUrl: string): Operation | undefined {
  return byRoute.get(`${method.toUpperCase()} ${openApiPath(fastifyUrl)}`);
}

/** Whether API keys may call this route; the permission it needs, or null when they may not. */
export function apiKeyScopeFor(method: string, fastifyUrl: string): Permission | null {
  const op = operationFor(method, fastifyUrl);
  return op?.auth.kind === 'org' && op.auth.apiKey ? op.auth.permission : null;
}

export { problemSchema };
