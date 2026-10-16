import { parseArgs } from 'node:util';
import { emailField } from '@credforge/contracts';
import { and, createDatabase, credential, eq, organization, statusList, user } from '@credforge/db';
import { z } from 'zod';
import { recordAudit } from './audit/audit';
import { createAuth } from './auth/auth';
import { loadConfigOrExit } from './config';
import { eraseRecipient, previewErasure, reapplyErasures } from './credentials/erasure';
import { revokeCredentials } from './credentials/revocation';
import { createKeyEncryption } from './crypto/key-encryption';
import { loadDevEnvFile } from './dev-env';
import { createMemoryOutbox } from './email/outbox';
import { createStorage } from './files/storage';
import { listsWaitingToPublish, publishStatusList } from './status-lists/service';

const USAGE = `credforge command line

Usage:
  node dist/cli.js create-platform-admin --email <address> [--name <name>]
  node dist/cli.js remove-platform-admin --email <address>
  node dist/cli.js publish-status-lists [--all]
  node dist/cli.js revoke-org-credentials --org <id> --reason <text> [--public-reason <text>] [--yes]
  node dist/cli.js erase-recipient --org <id> (--email <address> | --credential <id>) [--yes]
  node dist/cli.js reapply-erasures

Commands:
  create-platform-admin   Make a user a platform admin (approves and suspends organizations).
                          Creates the account if it doesn't exist yet and prints a link to set
                          its password. Run it once to set up a new instance.
  remove-platform-admin   Take away a user's platform admin rights (the account stays).
  publish-status-lists    Re-sign and publish status lists with revocations not yet published
                          (the worker does this within seconds; use it if the worker was down).
                          --all re-signs every list.
  revoke-org-credentials  Revoke every badge a suspended organization awarded (abuse: phishing,
                          impersonation). Suspend it on the Platform screen first. Without --yes
                          it only says how many badges it would revoke.
  erase-recipient         Erase a recipient's data from an organization's records, as its owners
                          and admins can in the issuer app: for a request that reaches the
                          operator. Revokes their badges (they stay revoked), removes the
                          credentials, name and address everywhere, and seals the audit log's
                          mentions for good. Without --yes it only says what it would erase.
  reapply-erasures        After restoring a backup: erases again what was erased since the backup
                          was taken (from the erasure records in the files bucket). restore.sh
                          runs it.

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

async function removePlatformAdmin(args: string[]) {
  const { values } = parseArgs({ args, options: { email: { type: 'string' } } });
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
    if (!existing?.isPlatformAdmin) {
      console.log(`${email} isn't a platform admin.`);
      return 0;
    }
    await db.transaction(async (tx) => {
      await tx
        .update(user)
        .set({ isPlatformAdmin: false, updatedAt: new Date() })
        .where(eq(user.id, existing.id));
      await recordAudit(tx, {
        actor: CLI_ACTOR,
        action: 'user.platform_admin_revoked',
        target: { type: 'user', id: existing.id },
        data: { email },
      });
    });
    console.log(`${email} is no longer a platform admin.`);
    return 0;
  } finally {
    await pool.end();
  }
}

async function publishStatusLists(args: string[]) {
  const { values } = parseArgs({ args, options: { all: { type: 'boolean' } } });
  const config = loadConfigOrExit();
  const { db, pool } = createDatabase(config.databaseUrl, {
    applicationName: 'credforge-cli',
    max: 2,
  });
  try {
    const ids = values.all
      ? (await db.select({ id: statusList.id }).from(statusList)).map((row) => row.id)
      : await listsWaitingToPublish(db);
    if (values.all) {
      for (const id of ids) {
        await db.update(statusList).set({ needsPublish: true }).where(eq(statusList.id, id));
      }
    }
    const services = { db, config, keys: createKeyEncryption(config.masterKey) };
    let published = 0;
    for (const id of ids) if (await publishStatusList(services, id)) published++;
    console.log(`Published ${published} status ${published === 1 ? 'list' : 'lists'}.`);
    return 0;
  } finally {
    await pool.end();
  }
}

/** Abuse (design plan §6.3): revokes everything a suspended org awarded, then re-signs its lists. */
async function revokeOrgCredentials(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      org: { type: 'string' },
      reason: { type: 'string' },
      'public-reason': { type: 'string' },
      yes: { type: 'boolean' },
    },
  });
  const orgId = z.uuid().safeParse(values.org ?? '');
  const reason = values.reason?.trim();
  if (!orgId.success || !reason) {
    console.error('Give the organization with --org <id> and a --reason.\n');
    console.error(USAGE);
    return 2;
  }
  const config = loadConfigOrExit();
  const { db, pool } = createDatabase(config.databaseUrl, {
    applicationName: 'credforge-cli',
    max: 2,
  });
  try {
    const [org] = await db.select().from(organization).where(eq(organization.id, orgId.data));
    if (!org) {
      console.error('No organization with that id.');
      return 1;
    }
    if (org.status !== 'suspended') {
      console.error(`${org.name} is ${org.status}. Suspend it on the Platform screen first.`);
      return 1;
    }
    const issued = and(eq(credential.orgId, org.id), eq(credential.status, 'issued'));
    const total = (await db.select({ id: credential.id }).from(credential).where(issued)).length;
    if (!values.yes) {
      console.log(
        `${org.name} has ${total} badges that aren't revoked. Run again with --yes to revoke them.`,
      );
      return total === 0 ? 0 : 1;
    }
    const services = {
      db,
      config,
      keys: createKeyEncryption(config.masterKey),
      outbox: createMemoryOutbox(),
    };
    let revoked = 0;
    for (;;) {
      const ids = (
        await db.select({ id: credential.id }).from(credential).where(issued).limit(500)
      ).map((row) => row.id);
      if (ids.length === 0) break;
      const result = await revokeCredentials(
        services,
        org.id,
        ids,
        { reason, publicReason: values['public-reason']?.trim() || null },
        CLI_ACTOR,
        {},
      );
      revoked += result.revoked.length;
    }
    let published = 0;
    for (const id of await listsWaitingToPublish(db)) {
      if (await publishStatusList(services, id)) published++;
    }
    console.log(
      `Revoked ${revoked} badges of ${org.name} and re-signed ${published} status lists.`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

/** Design plan §12.1: the operator's way to honor a deletion request that reaches them. */
async function eraseRecipientCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      org: { type: 'string' },
      email: { type: 'string' },
      credential: { type: 'string' },
      yes: { type: 'boolean' },
    },
  });
  const orgId = z.uuid().safeParse(values.org ?? '');
  const email = values.email !== undefined ? emailField.safeParse(values.email) : undefined;
  const credentialId =
    values.credential !== undefined ? z.uuid().safeParse(values.credential) : undefined;
  if (
    !orgId.success ||
    (email === undefined) === (credentialId === undefined) ||
    (email && !email.success) ||
    (credentialId && !credentialId.success)
  ) {
    console.error('Give the organization with --org <id>, and either --email or --credential.\n');
    console.error(USAGE);
    return 2;
  }
  const config = loadConfigOrExit();
  const { db, pool } = createDatabase(config.databaseUrl, {
    applicationName: 'credforge-cli',
    max: 2,
  });
  try {
    const [org] = await db.select().from(organization).where(eq(organization.id, orgId.data));
    if (!org) {
      console.error('No organization with that id.');
      return 1;
    }
    let start: { credentialId: string } | { email: string };
    if (credentialId?.data) {
      start = { credentialId: credentialId.data.toLowerCase() };
    } else {
      start = { email: email?.data ?? '' };
    }
    if (!values.yes) {
      // What the issuer app shows before confirming, from any badge to that address.
      const [anchor] =
        'credentialId' in start
          ? [{ id: start.credentialId }]
          : await db
              .select({ id: credential.id })
              .from(credential)
              .where(and(eq(credential.orgId, org.id), eq(credential.recipientEmail, start.email)))
              .limit(1);
      if (!anchor) {
        console.log(
          `${org.name} awarded no badge to that address. With --yes, rows of its CSV uploads holding it are erased.`,
        );
        return 1;
      }
      const preview = await previewErasure(db, org.id, anchor.id);
      console.log(
        `Would erase ${preview.credentials.filter((row) => !row.erased).length} badges of ${org.name} ` +
          `(revoking ${preview.toRevoke}) and ${preview.batchRows} CSV rows. Run again with --yes.`,
      );
      return 1;
    }
    const storage = createStorage(config.storage);
    const result = await eraseRecipient({ db, storage }, org.id, start, CLI_ACTOR, {});
    const services = { db, config, keys: createKeyEncryption(config.masterKey) };
    let published = 0;
    for (const id of await listsWaitingToPublish(db)) {
      if (await publishStatusList(services, id)) published++;
    }
    console.log(
      `Erased ${result.erased.length} badges (${result.revoked.length} revoked now) and ` +
        `${result.batchRows} CSV rows; re-signed ${published} status lists. Erasure ${result.erasureId}.`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

/** After a restore (design plan §12.1, §13.4): erasures made since the backup, made again. */
async function reapplyErasuresCommand() {
  const config = loadConfigOrExit();
  const { db, pool } = createDatabase(config.databaseUrl, {
    applicationName: 'credforge-cli',
    max: 2,
  });
  try {
    const storage = createStorage(config.storage);
    const result = await reapplyErasures({ db, storage }, CLI_ACTOR);
    const services = { db, config, keys: createKeyEncryption(config.masterKey) };
    let published = 0;
    for (const id of await listsWaitingToPublish(db)) {
      if (await publishStatusList(services, id)) published++;
    }
    console.log(
      `${result.entries} erasure records; ${result.reapplied} applied again; re-signed ${published} status lists.`,
    );
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
    case 'remove-platform-admin':
      return removePlatformAdmin(rest);
    case 'publish-status-lists':
      return publishStatusLists(rest);
    case 'revoke-org-credentials':
      return revokeOrgCredentials(rest);
    case 'erase-recipient':
      return eraseRecipientCommand(rest);
    case 'reapply-erasures':
      return reapplyErasuresCommand();
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
