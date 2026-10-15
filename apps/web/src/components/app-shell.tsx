import type { MeResponse } from '@credforge/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  BadgeCheck,
  Building2,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Settings,
  ShieldCheck,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { authClient } from '../lib/auth-client';
import { cn } from '../lib/utils';
import { Wordmark } from './brand';
import { Select } from './ui/input';

const navLink =
  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-4 [&.active]:bg-accent [&.active]:font-semibold [&.active]:text-foreground';

function OrgNav({ orgId, onNavigate }: { orgId: string; onNavigate: () => void }) {
  const items = [
    { to: '/app/orgs/$orgId', label: 'Overview', icon: LayoutDashboard, exact: true },
    { to: '/app/orgs/$orgId/issuer', label: 'Issuer profile', icon: BadgeCheck },
    { to: '/app/orgs/$orgId/members', label: 'Members', icon: Users },
    { to: '/app/orgs/$orgId/settings', label: 'Organization settings', icon: Settings },
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

/** The signed-in app: a sidebar (an overlay panel on small screens) and the page. */
export function AppShell({ me, children }: { me: MeResponse; children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { orgId?: string };
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const currentOrg = me.memberships.find((membership) => membership.org.id === params.orgId);

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: '/login' });
  }

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-center justify-between">
        <Wordmark />
        <button
          type="button"
          className="rounded-md p-2 hover:bg-muted lg:hidden"
          onClick={close}
          aria-label="Close menu"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>

      {me.memberships.length > 0 && (
        <div className="grid gap-2">
          <label
            htmlFor="org-switcher"
            className="px-1 text-xs font-semibold text-muted-foreground uppercase"
          >
            Organization
          </label>
          <Select
            id="org-switcher"
            value={currentOrg?.org.id ?? ''}
            onChange={(event) => {
              close();
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
        {currentOrg && <OrgNav orgId={currentOrg.org.id} onNavigate={close} />}
        <ul className="grid gap-1">
          <li>
            <Link to="/app/orgs/new" className={navLink} onClick={close}>
              <Plus aria-hidden="true" />
              New organization
            </Link>
          </li>
          {me.user.isPlatformAdmin && (
            <li>
              <Link to="/app/platform" className={navLink} onClick={close}>
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
          onClick={close}
          activeOptions={{ exact: true }}
        >
          <UserCog aria-hidden="true" />
          Account settings
        </Link>
        <button type="button" className={cn(navLink, 'w-full text-left')} onClick={signOut}>
          <LogOut aria-hidden="true" />
          Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[17rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-screen border-r bg-sidebar lg:block">{sidebar}</aside>

      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-sidebar px-4 lg:hidden">
        <Wordmark />
        <button
          type="button"
          className="rounded-md p-2 hover:bg-muted"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-ink/50"
            aria-label="Close menu"
            onClick={close}
          />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto bg-sidebar shadow-xl">
            {sidebar}
          </aside>
        </div>
      )}

      <main id="main" className="min-w-0 px-4 py-8 sm:px-8 lg:py-10">
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
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: typeof Building2;
}) {
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
