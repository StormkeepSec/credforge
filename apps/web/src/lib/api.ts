import type {
  AuditEventPage,
  InstanceInfo,
  Invitation,
  InvitationPreview,
  Issuer,
  Member,
  MeResponse,
  OrgDetails,
  OrgStatus,
  PlatformOrg,
  Problem,
  ProblemCode,
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
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
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
  platformOrgs: (status: OrgStatus | 'all') =>
    queryOptions({
      queryKey: ['platform', 'orgs', status],
      queryFn: () =>
        api<{ orgs: PlatformOrg[] }>(
          `/platform/orgs${status === 'all' ? '' : `?status=${status}`}`,
        ),
    }),
};

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
