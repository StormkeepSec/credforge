import type { MeResponse } from '@credforge/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Award,
  BadgeCheck,
  Building2,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Medal,
  Menu,
  Plus,
  Send,
  Settings,
  ShieldCheck,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { authClient } from '../lib/auth-client';
import { cn, useDocumentTitle } from '../lib/utils';
import { Wordmark } from './brand';
import { Button } from './ui/button';
import { Select } from './ui/input';

const navLink =
  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-4 [&.active]:bg-accent [&.active]:font-semibold [&.active]:text-foreground';

function OrgNav({ orgId, onNavigate }: { orgId: string; onNavigate: () => void }) {
  const items = [
    { to: '/app/orgs/$orgId', label: 'Overview', icon: LayoutDashboard, exact: true },
    { to: '/app/orgs/$orgId/achievements', label: 'Achievements', icon: Award },
    { to: '/app/orgs/$orgId/award', label: 'Award a badge', icon: Send },
    { to: '/app/orgs/$orgId/credentials', label: 'Awarded badges', icon: Inbox },
    { to: '/app/orgs/$orgId/issuer', label: 'Issuer profile', icon: BadgeCheck },
    { to: '/app/orgs/$orgId/members', label: 'Members', icon: Users },
    { to: '/app/orgs/$orgId/settings', label: 'Organization settings', icon: Settings },
    { to: '/app/orgs/$orgId/api-keys', label: 'API keys', icon: KeyRound },
  ] as const;
  return (
    <ul className="grid gap-1">
      {items.map((item) => (
        <li key={item.to}>
          <Link
            to={item.to}
            params={{ orgId }}
            activeOptions={{ exact: 'exact' in item }}
            className={navLink}
            onClick={onNavigate}
          >
            <item.icon aria-hidden="true" />
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * The sidebar's contents. Rendered once for the desktop column and once for the mobile panel, so
 * each copy gets its own ids (a shared id would label only the hidden copy's org switcher).
 */
function Sidebar({
  me,
  orgId,
  onNavigate,
  onSignOut,
  closeButton,
}: {
  me: MeResponse;
  orgId?: string;
  onNavigate: () => void;
  onSignOut: () => void;
  closeButton?: ReactNode;
}) {
  const navigate = useNavigate();
  const switcherId = useId();
  const currentOrg = me.memberships.find((membership) => membership.org.id === orgId);

  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-center justify-between">
        <Wordmark />
        {closeButton}
      </div>

      {me.memberships.length > 0 && (
        <div className="grid gap-2">
          <label
            htmlFor={switcherId}
            className="px-1 text-xs font-semibold text-muted-foreground uppercase"
          >
            Organization
          </label>
          <Select
            id={switcherId}
            value={currentOrg?.org.id ?? ''}
            onChange={(event) => {
              onNavigate();
              if (event.target.value) {
                void navigate({ to: '/app/orgs/$orgId', params: { orgId: event.target.value } });
              }
            }}
          >
            {!currentOrg && <option value="">Choose…</option>}
            {me.memberships.map((membership) => (
              <option key={membership.org.id} value={membership.org.id}>
                {membership.org.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      <div className="grid flex-1 content-start gap-4">
        {currentOrg && <OrgNav orgId={currentOrg.org.id} onNavigate={onNavigate} />}
        <ul className="grid gap-1">
          <li>
            <Link to="/app/badges" className={navLink} onClick={onNavigate}>
              <Medal aria-hidden="true" />
              My badges
            </Link>
          </li>
          <li>
            <Link to="/app/orgs/new" className={navLink} onClick={onNavigate}>
              <Plus aria-hidden="true" />
              New organization
            </Link>
          </li>
          {me.user.isPlatformAdmin && (
            <li>
              <Link to="/app/platform" className={navLink} onClick={onNavigate}>
                <ShieldCheck aria-hidden="true" />
                Platform
              </Link>
            </li>
          )}
        </ul>
      </div>

      <div className="grid gap-1 border-t pt-4">
        <p className="truncate px-3 text-sm font-semibold" title={me.user.email}>
          {me.user.name}
        </p>
        <p className="truncate px-3 pb-2 text-xs text-muted-foreground">{me.user.email}</p>
        <Link
          to="/app/settings"
          className={navLink}
          onClick={onNavigate}
          activeOptions={{ exact: true }}
        >
          <UserCog aria-hidden="true" />
          Account settings
        </Link>
        <button type="button" className={cn(navLink, 'w-full text-left')} onClick={onSignOut}>
          <LogOut aria-hidden="true" />
          Sign out
        </button>
      </div>
    </nav>
  );
}

/**
 * The signed-in app: a sidebar and the page. Below `lg` the sidebar is a panel over the page:
 * opening it moves focus into it, Escape or the close button closes it and returns focus to the
 * menu button, and the page behind is `inert` meanwhile so Tab can't wander under the panel.
 * (Not a modal dialog component: those lock scrolling with inline styles, which the CSP blocks.)
 */
export function AppShell({ me, children }: { me: MeResponse; children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { orgId?: string };
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const close = () => setOpen(false);

  useEffect(() => {
    if (open) {
      closeButton.current?.focus();
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') setOpen(false);
      };
      // At lg the panel is hidden by CSS; close it so the page doesn't stay inert.
      const wide = window.matchMedia('(min-width: 64rem)');
      const onResize = () => wide.matches && setOpen(false);
      document.addEventListener('keydown', onKeyDown);
      wide.addEventListener('change', onResize);
      wasOpen.current = true;
      return () => {
        document.removeEventListener('keydown', onKeyDown);
        wide.removeEventListener('change', onResize);
      };
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      menuButton.current?.focus();
    }
  }, [open]);

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: '/login' });
  }

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[17rem_1fr]">
      <a
        href="#main"
        inert={open}
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-screen border-r bg-sidebar lg:block">
        <Sidebar me={me} orgId={params.orgId} onNavigate={close} onSignOut={signOut} />
      </aside>

      <header
        inert={open}
        className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-sidebar px-4 lg:hidden"
      >
        <Wordmark />
        <Button
          ref={menuButton}
          variant="ghost"
          size="icon"
          className="[&_svg]:size-5"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
        >
          <Menu aria-hidden="true" />
        </Button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          {/* Clicking outside closes the panel; keyboard users have the close button and Escape. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="absolute inset-0 bg-ink/50 dark:bg-black/70"
            onClick={close}
          />
          <aside
            id={menuId}
            className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto border-r bg-sidebar shadow-xl"
          >
            <Sidebar
              me={me}
              orgId={params.orgId}
              onNavigate={close}
              onSignOut={signOut}
              closeButton={
                <Button
                  ref={closeButton}
                  variant="ghost"
                  size="icon"
                  className="[&_svg]:size-5"
                  onClick={close}
                  aria-label="Close menu"
                >
                  <X aria-hidden="true" />
                </Button>
              }
            />
          </aside>
        </div>
      )}

      <main id="main" inert={open} className="min-w-0 px-4 py-8 sm:px-8 lg:py-10">
        <div className="mx-auto max-w-4xl">{children}</div>
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  icon: Icon = Building2,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: typeof Building2;
}) {
  useDocumentTitle(title);
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <Icon className="mt-1 size-6 shrink-0 text-link" aria-hidden="true" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
          {description && <p className="mt-1 text-muted-foreground">{description}</p>}
        </div>
      </div>
      {actions}
    </div>
  );
}
