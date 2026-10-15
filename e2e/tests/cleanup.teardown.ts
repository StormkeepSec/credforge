import { test as teardown } from '@playwright/test';
import { post, removePlatformAdmin } from '../support/accounts';
import { fixtures, hasFixtures, SIGNED_IN } from '../support/fixtures';
import { BASE_URL } from '../support/stack';

// Takes this run's organization out of the platform approval queue, so the queue the platform
// test checks doesn't grow with every run, and takes this run's platform admin rights away: every
// new organization emails every platform admin, and a growing pile of them delays every later
// run's email. The accounts stay (they use reserved .test addresses).
teardown('decline this run’s organization', async ({ playwright }) => {
  teardown.skip(!hasFixtures(), 'Setup did not finish, so there is nothing to clean up.');
  const request = await playwright.request.newContext({
    baseURL: BASE_URL,
    storageState: SIGNED_IN.admin,
  });
  try {
    await post(request, `/api/v1/platform/orgs/${fixtures().org.id}/decline`, {
      reason: 'End-to-end test run finished.',
    });
  } finally {
    await request.dispose();
    await removePlatformAdmin(fixtures().admin.email);
  }
});
