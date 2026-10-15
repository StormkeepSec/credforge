import { parseArgs } from 'node:util';
import { emailField } from '@credforge/contracts';
import { createDatabase, eq, user } from '@credforge/db';
import { recordAudit } from './audit/audit';
import { createAuth } from './auth/auth';
import { loadConfigOrExit } from './config';
import { loadDevEnvFile } from './dev-env';
import { createMemoryOutbox } from './email/outbox';

const USAGE = `credforge command line

Usage:
  node dist/cli.js create-platform-admin --email <address> [--name <name>]

Commands:
  create-platform-admin   Make a user a platform admin (approves and suspends organizations).
                          Creates the account if it doesn't exist yet and prints a link to set
                          its password. Run it once to set up a new instance.

In docker compose:  docker compose exec app node dist/cli.js create-platform-admin --email you@example.org`;

const CLI_ACTOR = { type: 'system' as const, label: 'cli' };

async function createPlatformAdmin(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { email: { type: 'string' }, name: { type: 'string' } },
  });
  const parsedEmail = emailField.safeParse(values.email ?? '');
  if (!parsedEmail.success) {
    console.error('Give a valid --email address.\n');
    console.error(USAGE);
    return 2;
  }
  const email = parsedEmail.data;

  const config = loadConfigOrExit();
  const { db, pool } = createDatabase(config.databaseUrl, {
    applicationName: 'credforge-cli',
    max: 2,
  });
  try {
    const [existing] = await db.select().from(user).where(eq(user.email, email));
    if (existing) {
      if (existing.isPlatformAdmin) {
        console.log(`${email} is already a platform admin.`);
        return 0;
      }
      await db.transaction(async (tx) => {
        await tx
          .update(user)
          .set({ isPlatformAdmin: true, updatedAt: new Date() })
          .where(eq(user.id, existing.id));
        await recordAudit(tx, {
          actor: CLI_ACTOR,
          action: 'user.platform_admin_granted',
          target: { type: 'user', id: existing.id },
          data: { email },
        });
      });
      console.log(`${email} is now a platform admin. They sign in as usual.`);
      if (config.requireMfaForAdmins) {
        console.log('They must turn on two-step verification at their next sign-in.');
      }
      return 0;
    }

    const name = values.name?.trim() || email.split('@')[0] || email;
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(user)
        .values({ name, email, emailVerified: true, isPlatformAdmin: true })
        .returning();
      if (!row) throw new Error('Insert returned no row.');
      await recordAudit(tx, {
        actor: CLI_ACTOR,
        action: 'user.created',
        target: { type: 'user', id: row.id },
        data: { email, method: 'cli' },
      });
      await recordAudit(tx, {
        actor: CLI_ACTOR,
        action: 'user.platform_admin_granted',
        target: { type: 'user', id: row.id },
        data: { email },
      });
      return row;
    });

    // Better Auth issues the set-password link; capture it instead of emailing it.
    const outbox = createMemoryOutbox();
    const auth = createAuth({ config, db, outbox, log: console });
    await auth.api.requestPasswordReset({ body: { email } });
    const message = outbox.messages.find((sent) => sent.kind === 'reset-password');
    const link = message?.text.match(/https?:\/\/\S+reset-password\?token=\S+/)?.[0];
    if (!link) throw new Error('No set-password link was produced.');

    console.log(`Created platform admin ${created.email}.`);
    console.log('\nOpen this link within one hour to set the password (it works once):\n');
    console.log(`  ${link}\n`);
    console.log('Then sign in. Google or Microsoft sign-in can be connected later in Settings.');
    if (config.requireMfaForAdmins) {
      console.log('Two-step verification is required for platform admins on this instance.');
    }
    return 0;
  } finally {
    await pool.end();
  }
}

async function main(argv: string[]): Promise<number> {
  loadDevEnvFile();
  const [command, ...rest] = argv;
  switch (command) {
    case 'create-platform-admin':
      return createPlatformAdmin(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
