import { type APIRequestContext, expect, test as setup } from '@playwright/test';
import {
  type Account,
  enableTwoFactor,
  makePlatformAdmin,
  me,
  post,
  signUpAndConfirm,
} from '../support/accounts';
import {
  clearFixtures,
  generatePassword,
  newRunId,
  SIGNED_IN,
  saveFixtures,
  testEmail,
} from '../support/fixtures';
import { LINKS, mailLink } from '../support/mailpit';
import { BASE_URL, MAILPIT_URL, reachable } from '../support/stack';

// Seeds this run's accounts without the UI: Better Auth's API for sign-up and two-step
// verification, the confirmation and invitation links from Mailpit, and the server's CLI for the
// platform admin. Saves each account's signed-in cookies for the tests.

setup('seed accounts, an organization and invitations', async ({ playwright }) => {
  setup.setTimeout(120_000);
  clearFixtures();
  expect(
    await reachable(`${MAILPIT_URL}/api/v1/info`),
    `Mailpit isn't answering at ${MAILPIT_URL}. Start Postgres and Mailpit with \`pnpm infra:up\`.`,
  ).toBe(true);
  expect(
    await reachable(`${BASE_URL}/readyz`),
    `The app isn't ready at ${BASE_URL}. Start it with \`pnpm dev\` and wait for the server.`,
  ).toBe(true);

  const runId = newRunId();
  const password = generatePassword();
  const account = (who: string, name: string): Account => ({
    name,
    email: testEmail(runId, who),
    password,
  });
  const owner = account('owner', 'E2E Owner');
  const admin = account('admin', 'E2E Platform Admin');
  const invitee = account('invitee', 'E2E Invitee');
  const pendingInviteEmail = testEmail(runId, 'pending');
  const orgName = `E2E Academy ${runId}`;

  /** Runs `steps` with a cookie jar of its own and saves the session it ends with. */
  async function seed<T>(path: string, steps: (request: APIRequestContext) => Promise<T>) {
    const request = await playwright.request.newContext({ baseURL: BASE_URL });
    try {
      const result = await steps(request);
      await request.storageState({ path });
      return result;
    } finally {
      await request.dispose();
    }
  }

  const [ownerResult] = await Promise.all([
    seed(SIGNED_IN.owner, async (request) => {
      await signUpAndConfirm(request, owner);
      const org = await post<{ id: string }>(request, '/api/v1/orgs', { name: orgName });
      // Owners must turn on two-step verification before anything else (REQUIRE_MFA_FOR_ADMINS).
      const totpSecret = await enableTwoFactor(request, password);
      await post(request, `/api/v1/orgs/${org.id}/issuers`, {
        name: orgName,
        url: 'https://example.org',
        email: 'badges@example.org',
        description: 'Seeded by the end-to-end tests.',
      });
      await post(request, `/api/v1/orgs/${org.id}/invitations`, {
        email: invitee.email,
        role: 'issuer',
      });
      await post(request, `/api/v1/orgs/${org.id}/invitations`, {
        email: pendingInviteEmail,
        role: 'viewer',
      });
      expect((await me(request)).mfa.state).toBe('ok');
      return { org, totpSecret };
    }),
    seed(SIGNED_IN.admin, async (request) => {
      await signUpAndConfirm(request, admin);
      await makePlatformAdmin(admin.email);
      await enableTwoFactor(request, password);
      expect((await me(request)).mfa.state).toBe('ok');
    }),
    seed(SIGNED_IN.invitee, (request) => signUpAndConfirm(request, invitee)),
  ]);

  const inviteLink = await mailLink(invitee.email, LINKS.invitation);
  saveFixtures({
    runId,
    password,
    org: { id: ownerResult.org.id, name: orgName },
    owner: { email: owner.email, totpSecret: ownerResult.totpSecret },
    admin: { email: admin.email },
    invitee: { email: invitee.email },
    inviteToken: inviteLink.slice(inviteLink.indexOf(LINKS.invitation) + LINKS.invitation.length),
    pendingInviteEmail,
  });
});
