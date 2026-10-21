import type { APIRequestContext } from '@playwright/test';
import { post } from './accounts';

// Content moderation (design plan §6.5). The development stack holds the content of orgs nobody
// marked trusted (MODERATION_REVIEW=untrusted, the default), so tests that look at public pages of
// their own org's content have the platform admin vouch for the org first.

interface QueueItem {
  id: string;
}

/** The org's content waiting for review, as the platform admin's moderation queue lists it. */
export async function pendingItems(admin: APIRequestContext, orgId: string): Promise<QueueItem[]> {
  const response = await admin.get(`/api/v1/platform/moderation/items?orgId=${orgId}&limit=100`);
  if (!response.ok())
    throw new Error(`moderation queue: ${response.status()} ${await response.text()}`);
  return ((await response.json()) as { items: QueueItem[] }).items;
}

/**
 * Marks the org trusted (its new content is published at once) and clears what already waits.
 * `admin` must be signed in as a platform admin.
 */
export async function trustOrg(admin: APIRequestContext, orgId: string): Promise<void> {
  await post(admin, `/api/v1/platform/orgs/${orgId}/trust`, { trusted: true });
  for (const item of await pendingItems(admin, orgId)) {
    await post(admin, `/api/v1/platform/moderation/items/${item.id}/clear`);
  }
}
