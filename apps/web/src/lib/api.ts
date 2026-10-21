import type {
  AccountEmail,
  Achievement,
  AchievementStatus,
  ApiKey,
  AuditEventPage,
  BatchDetails,
  BatchPage,
  BatchRowPage,
  ContentReportPage,
  CredentialDetails,
  CredentialFilters,
  CredentialPage,
  InstanceInfo,
  Invitation,
  InvitationPreview,
  Issuer,
  Member,
  MeResponse,
  ModerationItemPage,
  ModerationStatus,
  ModerationSummary,
  OrgDetails,
  OrgStatus,
  PlatformOrg,
  Problem,
  ProblemCode,
  RecipientCredentialPage,
  ReportStatus,
} from '@credforge/contracts';
import { queryOptions } from '@tanstack/react-query';

/** A failed `/api/v1` call, carrying the server's problem details. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Partial<Problem>,
  ) {
    super(problem.detail ?? problem.title ?? `Request failed (${status})`);
    this.name = 'ApiError';
  }

  get code(): ProblemCode | undefined {
    return this.problem.code;
  }

  /** Field errors from `validation_failed`. */
  get fieldErrors(): Record<string, string> {
    return this.problem.errors ?? {};
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; file?: File; contentType?: string } = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.file
      ? { 'content-type': init.contentType ?? (init.file.type || 'application/octet-stream') }
      : init.body === undefined
        ? undefined
        : { 'content-type': 'application/json' },
    body: init.file ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new ApiError(response.status, data ?? {});
  return data as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = (path: string) => api<void>(path, { method: 'DELETE' });
/** Uploads a file as the raw request body (image uploads). */
export const upload = <T>(path: string, file: File) => api<T>(path, { method: 'PUT', file });
/** Uploads a CSV file as the raw body (whatever type the browser guessed for it). */
export const uploadCsv = <T>(path: string, file: File) =>
  api<T>(path, { method: 'POST', file, contentType: 'text/csv' });

/** Search and filters as a query string, without empty values. */
export function filterQuery(filters: CredentialFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === 'string' && value.trim()) params.set(key, value.trim());
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

// ---- queries ----

export const queries = {
  instance: () =>
    queryOptions({
      queryKey: ['instance'],
      queryFn: () => api<InstanceInfo>('/instance'),
      staleTime: Number.POSITIVE_INFINITY,
    }),
  /** The current session, or null when signed out. */
  me: () =>
    queryOptions({
      queryKey: ['me'],
      queryFn: async () => {
        try {
          return await api<MeResponse>('/me');
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) return null;
          throw error;
        }
      },
      staleTime: 30_000,
    }),
  org: (orgId: string) =>
    queryOptions({ queryKey: ['org', orgId], queryFn: () => api<OrgDetails>(`/orgs/${orgId}`) }),
  members: (orgId: string) =>
    queryOptions({
      queryKey: ['org', orgId, 'members'],
      queryFn: () => api<{ members: Member[] }>(`/orgs/${orgId}/members`),
    }),
  invitations: (orgId: string) =>
    queryOptions({
      queryKey: ['org', orgId, 'invitations'],
      queryFn: () => api<{ invitations: Invitation[] }>(`/orgs/${orgId}/invitations`),
    }),
  issuers: (orgId: string) =>
    queryOptions({
      queryKey: ['org', orgId, 'issuers'],
      queryFn: () => api<{ issuers: Issuer[] }>(`/orgs/${orgId}/issuers`),
    }),
  invitationPreview: (token: string) =>
    queryOptions({
      queryKey: ['invitation', token],
      queryFn: () => api<InvitationPreview>(`/invitations/${encodeURIComponent(token)}`),
      retry: false,
    }),
  achievements: (orgId: string, status?: AchievementStatus) =>
    queryOptions({
      queryKey: ['org', orgId, 'achievements', status ?? 'all'],
      queryFn: () =>
        api<{ achievements: Achievement[] }>(
          `/orgs/${orgId}/achievements${status ? `?status=${status}` : ''}`,
        ),
    }),
  achievement: (orgId: string, achievementId: string) =>
    queryOptions({
      queryKey: ['org', orgId, 'achievement', achievementId],
      queryFn: () => api<Achievement>(`/orgs/${orgId}/achievements/${achievementId}`),
    }),
  credential: (orgId: string, credentialId: string) =>
    queryOptions({
      queryKey: ['org', orgId, 'credential', credentialId],
      queryFn: () => api<CredentialDetails>(`/orgs/${orgId}/credentials/${credentialId}`),
    }),
  batches: (orgId: string) =>
    queryOptions({
      queryKey: ['org', orgId, 'batches'],
      queryFn: () => api<BatchPage>(`/orgs/${orgId}/batches?limit=20`),
    }),
  batch: (orgId: string, batchId: string) =>
    queryOptions({
      queryKey: ['org', orgId, 'batch', batchId],
      queryFn: () => api<BatchDetails>(`/orgs/${orgId}/batches/${batchId}`),
    }),
  batchRows: (orgId: string, batchId: string, query: string) =>
    queryOptions({
      queryKey: ['org', orgId, 'batch', batchId, 'rows', query],
      queryFn: () => api<BatchRowPage>(`/orgs/${orgId}/batches/${batchId}/rows?${query}`),
    }),
  apiKeys: (orgId: string) =>
    queryOptions({
      queryKey: ['org', orgId, 'api-keys'],
      queryFn: () => api<{ apiKeys: ApiKey[] }>(`/orgs/${orgId}/api-keys`),
    }),
  /** Extra addresses for My badges (design plan §8.8). */
  accountEmails: () =>
    queryOptions({
      queryKey: ['me', 'emails'],
      queryFn: () => api<{ emails: AccountEmail[] }>('/me/emails'),
    }),
  platformOrgs: (status: OrgStatus | 'all') =>
    queryOptions({
      queryKey: ['platform', 'orgs', status],
      queryFn: () =>
        api<{ orgs: PlatformOrg[] }>(
          `/platform/orgs${status === 'all' ? '' : `?status=${status}`}`,
        ),
    }),
  moderationSummary: () =>
    queryOptions({
      queryKey: ['platform', 'moderation', 'summary'],
      queryFn: () => api<ModerationSummary>('/platform/moderation/summary'),
    }),
  /** The moderation queue (design plan §6.5); `orgId` narrows it to one organization. */
  moderationItems: (status: ModerationStatus, orgId?: string) =>
    queryOptions({
      queryKey: ['platform', 'moderation', 'items', status, orgId ?? null],
      queryFn: () =>
        api<ModerationItemPage>(
          `/platform/moderation/items?status=${status}&limit=100${orgId ? `&orgId=${orgId}` : ''}`,
        ),
    }),
  reports: (status: ReportStatus) =>
    queryOptions({
      queryKey: ['platform', 'moderation', 'reports', status],
      queryFn: () => api<ContentReportPage>(`/platform/reports?status=${status}&limit=100`),
    }),
};

export async function fetchCredentialPage(
  orgId: string,
  filters: CredentialFilters = {},
  before?: string,
) {
  const query = filterQuery({ ...filters, ...(before && { before }) } as CredentialFilters);
  return api<CredentialPage>(`/orgs/${orgId}/credentials${query}`);
}

/** One page of My badges: the signed-in person's own badges, newest first. */
export async function fetchMyCredentials(before?: string) {
  return api<RecipientCredentialPage>(
    `/me/credentials${before ? `?before=${encodeURIComponent(before)}` : ''}`,
  );
}

export async function fetchAuditPage(orgId: string, before?: number) {
  return api<AuditEventPage>(`/orgs/${orgId}/audit-events${before ? `?before=${before}` : ''}`);
}

/** A readable message for any error from the API or Better Auth. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return 'Something went wrong. Try again.';
}
