import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
  useParams,
} from '@tanstack/react-router';
import { z } from 'zod';
import { AppShell } from './components/app-shell';
import { AuthLayout } from './components/auth-layout';
import { Button } from './components/ui/button';
import { Alert, Spinner } from './components/ui/feedback';
import { ApiError, errorMessage, queries } from './lib/api';
import {
  ForgotPasswordPage,
  ResetPasswordPage,
  TwoFactorPage,
  VerifyEmailPage,
} from './pages/account-links';
import { AccountSettingsPage } from './pages/account-settings';
import { AchievementEditorPage } from './pages/achievement-editor';
import { AchievementsPage } from './pages/achievements';
import { AwardPage } from './pages/award';
import { CredentialDetailPage, CredentialsPage } from './pages/credentials';
import { InvitePage } from './pages/invite';
import { LoginPage } from './pages/login';
import { NewOrgPage } from './pages/new-org';
import { OrgIssuerPage } from './pages/org-issuer';
import { OrgMembersPage } from './pages/org-members';
import { OrgOverviewPage } from './pages/org-overview';
import { OrgSettingsPage } from './pages/org-settings';
import { PlatformPage } from './pages/platform';
import { SignupPage } from './pages/signup';
import { TwoFactorSetupPage } from './pages/two-factor-setup';

interface RouterContext {
  queryClient: QueryClient;
}

function NotFound() {
  return (
    <AuthLayout
      title="Page not found"
      description="The link may be mistyped, or the page may have moved."
    >
      <Button asChild>
        <Link to="/app">Go to credforge</Link>
      </Button>
    </AuthLayout>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFound,
});

// ---- signed-out screens ----

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: z.object({
    redirect: z.string().optional(),
    error: z.string().optional(),
    email: z.string().optional(),
  }),
  component: function Login() {
    return <LoginPage search={loginRoute.useSearch()} />;
  },
});

const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signup',
  validateSearch: z.object({ redirect: z.string().optional(), email: z.string().optional() }),
  component: function Signup() {
    return <SignupPage search={signupRoute.useSearch()} />;
  },
});

const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify-email',
  validateSearch: z.object({
    error: z.string().optional(),
    email: z.string().optional(),
    resend: z.boolean().optional(),
  }),
  component: function VerifyEmail() {
    return <VerifyEmailPage search={verifyEmailRoute.useSearch()} />;
  },
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  validateSearch: z.object({ email: z.string().optional() }),
  component: function ForgotPassword() {
    return <ForgotPasswordPage search={forgotPasswordRoute.useSearch()} />;
  },
});

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  validateSearch: z.object({ token: z.string().optional(), error: z.string().optional() }),
  component: function ResetPassword() {
    return <ResetPasswordPage search={resetPasswordRoute.useSearch()} />;
  },
});

const twoFactorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/two-factor',
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: function TwoFactor() {
    return <TwoFactorPage search={twoFactorRoute.useSearch()} />;
  },
});

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: function Invite() {
    const { token } = inviteRoute.useParams();
    return <InvitePage token={token} />;
  },
});

// ---- the signed-in app ----

const TWO_FACTOR_SETUP = '/app/settings/two-factor';

/**
 * Every /app page needs a session that may use the app. Otherwise send the person to the step
 * they're missing: sign in, confirm their email, enter their second factor, or set it up.
 */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/app',
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(queries.me());
    if (!me) throw redirect({ to: '/login', search: { redirect: location.href } });
    if (!me.user.emailVerified)
      throw redirect({ to: '/verify-email', search: { resend: true, email: me.user.email } });
    if (me.mfa.state === 'challenge')
      throw redirect({ to: '/two-factor', search: { redirect: location.href } });
    if (me.mfa.state === 'setup' && location.pathname !== TWO_FACTOR_SETUP)
      throw redirect({ to: TWO_FACTOR_SETUP });
    return { me };
  },
  component: function App() {
    const { me } = appRoute.useRouteContext();
    return (
      <AppShell me={me}>
        <Outlet />
      </AppShell>
    );
  },
});

const appIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: ({ context }) => {
    const first = context.me.memberships[0];
    if (first) throw redirect({ to: '/app/orgs/$orgId', params: { orgId: first.org.id } });
    // An instance operator without an org of their own starts at the approval queue.
    if (context.me.user.isPlatformAdmin) throw redirect({ to: '/app/platform' });
    throw redirect({ to: '/app/orgs/new' });
  },
});

const newOrgRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/orgs/new',
  component: NewOrgPage,
});

const orgRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/orgs/$orgId',
  loader: ({ context, params }) => context.queryClient.ensureQueryData(queries.org(params.orgId)),
  pendingComponent: () => <Spinner />,
  errorComponent: function OrgError({ error }: { error: unknown }) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <Alert variant="error" title={missing ? 'Organization not found' : 'Something went wrong'}>
        {missing ? 'It doesn’t exist, or you’re not a member.' : errorMessage(error)}{' '}
        <Link to="/app">Go to your organizations</Link>
      </Alert>
    );
  },
  component: Outlet,
});

function useOrgId() {
  return (useParams({ strict: false }) as { orgId: string }).orgId;
}

const orgOverviewRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/',
  component: function Overview() {
    return <OrgOverviewPage orgId={useOrgId()} />;
  },
});

const orgIssuerRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/issuer',
  component: function IssuerProfile() {
    return <OrgIssuerPage orgId={useOrgId()} />;
  },
});

const achievementsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/achievements',
  component: function Achievements() {
    return <AchievementsPage orgId={useOrgId()} />;
  },
});

const newAchievementRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/achievements/new',
  component: function NewAchievement() {
    return <AchievementEditorPage orgId={useOrgId()} />;
  },
});

const achievementRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/achievements/$achievementId',
  validateSearch: z.object({ created: z.boolean().optional() }),
  component: function EditAchievement() {
    const { achievementId } = achievementRoute.useParams();
    const { created } = achievementRoute.useSearch();
    return (
      <AchievementEditorPage
        key={achievementId}
        orgId={useOrgId()}
        achievementId={achievementId}
        created={created}
      />
    );
  },
});

const awardRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/award',
  validateSearch: z.object({ achievementId: z.string().optional() }),
  component: function Award() {
    return <AwardPage orgId={useOrgId()} achievementId={awardRoute.useSearch().achievementId} />;
  },
});

const credentialsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/credentials',
  component: function Credentials() {
    return <CredentialsPage orgId={useOrgId()} />;
  },
});

const credentialRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/credentials/$credentialId',
  component: function Credential() {
    const { credentialId } = credentialRoute.useParams();
    return <CredentialDetailPage orgId={useOrgId()} credentialId={credentialId} />;
  },
});

const orgMembersRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/members',
  component: function Members() {
    return <OrgMembersPage orgId={useOrgId()} />;
  },
});

const orgSettingsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/settings',
  component: function OrgSettings() {
    return <OrgSettingsPage orgId={useOrgId()} />;
  },
});

const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  validateSearch: z.object({ error: z.string().optional() }),
  component: function Account() {
    return <AccountSettingsPage search={accountRoute.useSearch()} />;
  },
});

const twoFactorSetupRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/two-factor',
  component: TwoFactorSetupPage,
});

const platformRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/platform',
  beforeLoad: ({ context }) => {
    if (!context.me.user.isPlatformAdmin) throw redirect({ to: '/app' });
  },
  component: PlatformPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  signupRoute,
  verifyEmailRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  twoFactorRoute,
  inviteRoute,
  appRoute.addChildren([
    appIndexRoute,
    newOrgRoute,
    orgRoute.addChildren([
      orgOverviewRoute,
      achievementsRoute,
      newAchievementRoute,
      achievementRoute,
      awardRoute,
      credentialsRoute,
      credentialRoute,
      orgIssuerRoute,
      orgMembersRoute,
      orgSettingsRoute,
    ]),
    accountRoute,
    twoFactorSetupRoute,
    platformRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    // React Query owns caching; the router always asks it.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
