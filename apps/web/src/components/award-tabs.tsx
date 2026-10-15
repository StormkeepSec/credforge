import { Link } from '@tanstack/react-router';
import { cn } from '../lib/utils';

const tab =
  'inline-flex h-9 items-center rounded-md px-3 text-sm font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Switches between awarding one badge and awarding many from a file. The router marks the current one (aria-current). */
export function AwardTabs({ orgId, current }: { orgId: string; current: 'one' | 'many' }) {
  return (
    <nav aria-label="How to award" className="mb-6">
      <ul className="inline-flex gap-1 rounded-lg border bg-muted p-1">
        <li>
          <Link
            to="/app/orgs/$orgId/award"
            params={{ orgId }}
            activeOptions={{ exact: true }}
            className={cn(tab, current === 'one' && 'bg-card text-foreground shadow-sm')}
          >
            One person
          </Link>
        </li>
        <li>
          <Link
            to="/app/orgs/$orgId/award/many"
            params={{ orgId }}
            className={cn(tab, current === 'many' && 'bg-card text-foreground shadow-sm')}
          >
            Many people (CSV file)
          </Link>
        </li>
      </ul>
    </nav>
  );
}
