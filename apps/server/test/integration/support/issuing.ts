import { listsWaitingToPublish, publishStatusList } from '../../../src/status-lists/service';
import { BADGE_SVG } from '../../support/images';
import { newUser, type TestClient } from './client';
import type { TestEnvironment } from './harness';

/** What the worker's jobs need, built from a test environment. Tests run the jobs themselves. */
export function workerServices(env: TestEnvironment) {
  return { db: env.db, config: env.config, keys: env.keys, outbox: env.outbox };
}

/** Publishes every status list with unpublished changes, as the worker's job would. */
export async function publishStatusLists(env: TestEnvironment): Promise<number> {
  let published = 0;
  for (const id of await listsWaitingToPublish(env.db)) {
    if (await publishStatusList(workerServices(env), id)) published++;
  }
  return published;
}

export interface IssuingOrg {
  owner: TestClient;
  orgId: string;
  issuerId: string;
  achievementId: string;
  /** `/api/v1/orgs/{orgId}` */
  api: string;
}

/** An owner with an org, its issuer and a published achievement with SVG artwork. */
export async function issuingOrg(
  env: TestEnvironment,
  name = 'Example Cyber Academy',
): Promise<IssuingOrg> {
  const owner = await newUser(env, { name: 'Jordan Rivera' });
  const org = await owner.post('/api/v1/orgs', { name });
  const orgId = (org.json() as { id: string }).id;
  const api = `/api/v1/orgs/${orgId}`;
  const issuer = await owner.post(`${api}/issuers`, {
    name,
    url: 'https://example.org',
    email: 'badges@example.org',
  });
  const issuerId = (issuer.json() as { id: string }).id;
  const achievementId = await publishedAchievement(owner, api, 'Intro to Network Defense');
  return { owner, orgId, issuerId, achievementId, api };
}

export async function publishedAchievement(
  owner: TestClient,
  api: string,
  name: string,
): Promise<string> {
  const created = await owner.post(`${api}/achievements`, {
    name,
    description: 'Recognizes foundational skills in defending small networks.',
    criteriaNarrative: 'Completed all six labs.',
  });
  const id = (created.json() as { id: string }).id;
  const image = await owner.upload(
    `${api}/achievements/${id}/image`,
    Buffer.from(BADGE_SVG),
    'image/svg+xml',
  );
  if (image.statusCode !== 200) throw new Error(`image upload failed: ${image.body}`);
  const published = await owner.post(`${api}/achievements/${id}/publish`);
  if (published.statusCode !== 200) throw new Error(`publish failed: ${published.body}`);
  return id;
}

/** Awards one credential and returns its id. */
export async function awardTo(
  org: IssuingOrg,
  recipient: { name: string; email: string },
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await org.owner.post(`${org.api}/credentials`, {
    achievementId: org.achievementId,
    recipient,
    ...extra,
  });
  if (response.statusCode !== 201) throw new Error(`award failed: ${response.body}`);
  return (response.json() as { id: string }).id;
}
