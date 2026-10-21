import { createPrivateKey } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { emailField } from '@credforge/contracts';
import {
  and,
  createDatabase,
  credential,
  eq,
  file,
  moderationEvidence,
  organization,
  statusList,
  user,
} from '@credforge/db';
import { z } from 'zod';
import { recordAudit } from './audit/audit';
import { createAuth } from './auth/auth';
import { describeTwoFactorReset, resetTwoFactor } from './auth/two-factor-reset';
import { loadConfigOrExit } from './config';
import { eraseRecipient, previewErasure, reapplyErasures } from './credentials/erasure';
import { revokeAllOrgCredentials } from './credentials/revocation';
import { createKeyEncryption } from './crypto/key-encryption';
import { loadDevEnvFile } from './dev-env';
import { createMemoryOutbox, createQueueOutbox } from './email/outbox';
import { createStorage } from './files/storage';
import { blockKnownCsam, findImageByUrl, sameImageItems } from './moderation/csam';
import { envelopeSha256, openEvidence, readEnvelope } from './moderation/evidence';
import { createQueueClient } from './queue';
import { listsWaitingToPublish, publishStatusList } from './status-lists/service';

const USAGE = `credforge command line

Usage:
  node dist/cli.js create-platform-admin --email <address> [--name <name>]
  node dist/cli.js remove-platform-admin --email <address>
  node dist/cli.js reset-two-factor --email <address>
  node dist/cli.js publish-status-lists [--all]
  node dist/cli.js revoke-org-credentials --org <id> --reason <text> [--public-reason <text>] [--yes]
  node dist/cli.js erase-recipient --org <id> (--email <address> | --credential <id>) [--yes]
  node dist/cli.js reapply-erasures
  node dist/cli.js block-known-csam --image-url <url> --source <name> [--reference <text>] [--yes]
  node dist/cli.js export-evidence --id <evidence id>
  node dist/cli.js open-evidence --key <private key file> --in <file> --out <new folder>
                                 [--passphrase-file <file>]

Commands:
  create-platform-admin   Make a user a platform admin (approves and suspends organizations).
                          Creates the account if it doesn't exist yet and prints a link to set
                          its password. Run it once to set up a new instance.
  remove-platform-admin   Take away a user's platform admin rights (the account stays).
  reset-two-factor        Turn two-step verification off for someone who can't pass it (lost
                          phone and backup codes): deletes the authenticator secret and backup
                          codes, clears a lockout and ends their sessions. Owners, admins and
                          platform admins set it up again at their next sign-in when
                          REQUIRE_MFA_FOR_ADMINS=true. Confirm who is asking first.
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
  block-known-csam        For known child sexual abuse material found outside credforge (for
                          example by Cloudflare's CSAM Scanning Tool): blocks the image at that
                          URL, and every copy of the same image, as a matcher's match does. Seals
                          it as evidence (CSAM_EVIDENCE_PUBLIC_KEY), suspends the org, disables
                          the uploader. --source names who found it. Without --yes it only says
                          what it would do. See docs/abuse-handling.md, section 6.
  export-evidence         Writes sealed known-CSAM evidence to standard output, for the report to
                          the authorities. Needs the database owner (MIGRATION_DATABASE_URL): run
                          it in the migrate service. The export is recorded in the audit log.
  open-evidence           Opens exported evidence with the evidence private key, on the offline
                          machine that holds it: writes its manifest and image into a new folder.
                          Needs no configuration or database.

In docker compose:  docker compose exec app node dist/cli.js create-platform-admin --email you@example.org
Evidence export:    docker compose run --rm -T migrate node dist/cli.js export-evidence --id <id> > evidence.json`;

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

/** Design plan §6.4: the way back in after losing the second factor, audited unlike raw SQL. */
async function resetTwoFactorCommand(args: string[]) {
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
    const result = await resetTwoFactor(db, {
      email,
      requireMfaForAdmins: config.requireMfaForAdmins,
      actor: CLI_ACTOR,
    });
    const report = describeTwoFactorReset(email, result);
    if (result.outcome === 'no_account') {
      console.error(report);
      return 1;
    }
    console.log(report);
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
    const revoked = await revokeAllOrgCredentials(
      services,
      org.id,
      { reason, publicReason: values['public-reason']?.trim() || null },
      CLI_ACTOR,
      {},
    );
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

/**
 * Known CSAM found outside credforge (design plan §6.5, decision 61): blocks the image at a URL,
 * and every other copy of the same bytes, exactly as a match of the configured matcher does.
 */
async function blockKnownCsamCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      'image-url': { type: 'string' },
      source: { type: 'string' },
      reference: { type: 'string' },
      yes: { type: 'boolean' },
    },
  });
  const url = values['image-url']?.trim();
  const source = values.source?.trim();
  if (!url || !source) {
    console.error('Give the image with --image-url <url> and who found it with --source <name>.\n');
    console.error(USAGE);
    return 2;
  }
  const config = loadConfigOrExit();
  if (!config.moderation.evidencePublicKey) {
    console.error('Set CSAM_EVIDENCE_PUBLIC_KEY first: the image is kept only as sealed evidence.');
    return 1;
  }
  const { db, pool } = createDatabase(config.databaseUrl, {
    applicationName: 'credforge-cli',
    max: 2,
  });
  try {
    const found = await findImageByUrl(db, config.publicBaseUrl, url);
    if (!found) {
      console.error(`No badge image or issuer logo of this instance is at ${url}.`);
      return 1;
    }
    const items = [found.item, ...(await sameImageItems(db, found.item))];
    const [org] = await db
      .select({ name: organization.name, status: organization.status })
      .from(organization)
      .where(eq(organization.id, found.item.orgId));
    if (!values.yes) {
      console.log(
        `The image belongs to ${org?.name ?? 'an organization'} (${org?.status ?? 'unknown'}). ` +
          `${items.length} ${items.length === 1 ? 'copy' : 'copies'} of it would be blocked and sealed as evidence, ` +
          'their organizations suspended and the accounts that uploaded them disabled. Run again with --yes.',
      );
      return 1;
    }
    const boss = createQueueClient(config.databaseUrl, {
      applicationName: 'credforge-cli-queue',
      worker: false,
    });
    await boss.start();
    try {
      const deps = {
        db,
        config,
        storage: createStorage(config.storage),
        outbox: createQueueOutbox(boss),
      };
      for (const item of items) {
        const [stored] =
          item.id === found.item.id
            ? [found.file]
            : item.fileId
              ? await db.select().from(file).where(eq(file.id, item.fileId))
              : [];
        if (!stored) continue;
        const result = await blockKnownCsam(deps, {
          item,
          file: stored,
          source: 'operator',
          matcher: source,
          match: values.reference?.trim() ? { reference: values.reference.trim() } : {},
          actor: CLI_ACTOR,
        });
        console.log(`Blocked item ${item.id}: evidence ${result.evidenceId}.`);
      }
    } finally {
      await boss.stop({ graceful: true, timeout: 10_000 });
    }
    console.log('Report it to the authorities: docs/abuse-handling.md, section 6.');
    return 0;
  } finally {
    await pool.end();
  }
}

/** Sealed evidence, for the report to the authorities: read as the owner, written to stdout. */
async function exportEvidenceCommand(args: string[]) {
  const { values } = parseArgs({ args, options: { id: { type: 'string' } } });
  const id = z.uuid().safeParse(values.id ?? '');
  if (!id.success) {
    console.error('Give the evidence with --id <id> (the moderation queue shows it).\n');
    console.error(USAGE);
    return 2;
  }
  const config = loadConfigOrExit();
  // The app's role can't read sealed evidence back: only the database owner can.
  const { db, pool } = createDatabase(config.migrationDatabaseUrl, {
    applicationName: 'credforge-cli',
    max: 1,
  });
  try {
    const [row] = await db
      .select()
      .from(moderationEvidence)
      .where(eq(moderationEvidence.id, id.data));
    if (!row) {
      console.error('No evidence with that id.');
      return 1;
    }
    if (envelopeSha256(row.envelope) !== row.envelopeSha256) {
      console.error('The stored evidence doesn’t match its recorded SHA-256. Don’t use it.');
      return 1;
    }
    const by = `${userInfo().username}@${hostname()}`;
    await recordAudit(db, {
      orgId: null,
      actor: { type: 'system', label: `cli (${by})` },
      action: 'moderation.evidence_exported',
      target: { type: 'moderation_evidence', id: row.id },
      data: { orgId: row.orgId, itemId: row.itemId, envelopeSha256: row.envelopeSha256 },
    });
    process.stdout.write(row.envelope.toString('utf8'));
    console.error(
      `Exported evidence ${row.id} (SHA-256 ${row.envelopeSha256}), sealed to ${row.keyFingerprint}.`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

/**
 * Opens exported evidence with the private key. Run it only where the law and your lawyer say
 * the material may be handled, for the report: it writes the image itself to disk.
 */
async function openEvidenceCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      key: { type: 'string' },
      'passphrase-file': { type: 'string' },
      in: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!values.key || !values.in || !values.out) {
    console.error(
      'Give --key <private key file>, --in <exported evidence> and --out <new folder>.\n',
    );
    console.error(USAGE);
    return 2;
  }
  const passphrase = values['passphrase-file']
    ? (await readFile(values['passphrase-file'], 'utf8')).trim()
    : undefined;
  const privateKey = createPrivateKey({ key: await readFile(values.key), passphrase });
  const stored = await readFile(values.in);
  const envelope = readEnvelope(stored);
  const bundle = openEvidence(privateKey, stored);
  const existing = await readdir(values.out).catch(() => []);
  if (existing.length > 0) {
    console.error(`${values.out} isn’t empty: give a new folder.`);
    return 1;
  }
  await mkdir(values.out, { recursive: true, mode: 0o700 });
  await writeFile(
    join(values.out, 'manifest.json'),
    `${JSON.stringify(bundle.manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  for (const item of bundle.files) {
    await writeFile(join(values.out, item.name), item.bytes, { mode: 0o600 });
  }
  console.log(
    `Opened evidence ${envelope.id}: manifest.json and ${bundle.files.map((item) => item.name).join(', ')} in ${values.out}.`,
  );
  return 0;
}

async function main(argv: string[]): Promise<number> {
  loadDevEnvFile();
  const [command, ...rest] = argv;
  switch (command) {
    case 'create-platform-admin':
      return createPlatformAdmin(rest);
    case 'remove-platform-admin':
      return removePlatformAdmin(rest);
    case 'reset-two-factor':
      return resetTwoFactorCommand(rest);
    case 'publish-status-lists':
      return publishStatusLists(rest);
    case 'revoke-org-credentials':
      return revokeOrgCredentials(rest);
    case 'erase-recipient':
      return eraseRecipientCommand(rest);
    case 'reapply-erasures':
      return reapplyErasuresCommand();
    case 'block-known-csam':
      return blockKnownCsamCommand(rest);
    case 'export-evidence':
      return exportEvidenceCommand(rest);
    case 'open-evidence':
      return openEvidenceCommand(rest);
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
