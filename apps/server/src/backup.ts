import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import {
  createBackupClient,
  decryptFile,
  downloadBackup,
  listBackups,
  loadBackupConfig,
  pruneBackups,
  uploadBackup,
} from './backup/backup';

const USAGE = `credforge database backups (design plan §13.4)

Usage, in the "backup" compose service (deploy/backup.sh and deploy/restore.sh wrap these):
  node dist/backup.js upload --name <file name>   < dump     Encrypt stdin and upload it, then prune
  node dist/backup.js list                                    List backups, newest first
  node dist/backup.js prune                                   Delete backups past their retention
  node dist/backup.js download --key <key|latest> > dump      Download, decrypt and check a backup
  node dist/backup.js decrypt --file <path> > dump            Decrypt a backup file you downloaded

Settings: BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY (or _FILE),
BACKUP_S3_ENDPOINT and BACKUP_S3_REGION (default: S3_ENDPOINT, S3_REGION), BACKUP_PREFIX
(postgres/), BACKUP_RETENTION_DAYS (30), BACKUP_KEEP_MIN (7), and CREDFORGE_MASTER_KEY, from which
the encryption key is derived. Nothing is printed to stdout except the decrypted dump.`;

const NAME = /^[\w.-]{1,200}$/;

/**
 * Writes a verified, decrypted backup to stdout. It is decrypted to a temporary file first, so a
 * damaged or tampered backup never reaches pg_restore.
 */
async function decryptToStdout(masterKey: Buffer, encryptedPath: string, dir: string) {
  const plain = join(dir, 'plain.dump');
  await decryptFile(masterKey, encryptedPath, createWriteStream(plain));
  await pipeline(createReadStream(plain), process.stdout);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help') {
    console.error(USAGE);
    return command ? 0 : 2;
  }
  const { values } = parseArgs({
    args,
    options: { name: { type: 'string' }, key: { type: 'string' }, file: { type: 'string' } },
  });
  const config = loadBackupConfig();

  if (command === 'decrypt') {
    if (!values.file) {
      console.error('Give the backup file with --file.');
      return 2;
    }
    const dir = await mkdtemp(join(tmpdir(), 'credforge-restore-'));
    try {
      await decryptToStdout(config.masterKey, values.file, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return 0;
  }

  const client = createBackupClient(config);
  switch (command) {
    case 'upload': {
      if (!values.name || !NAME.test(values.name)) {
        console.error('Give a file name with --name (letters, digits, dots, dashes).');
        return 2;
      }
      if (process.stdin.isTTY) {
        console.error('Pipe the dump into stdin.');
        return 2;
      }
      const key = `${config.prefix}${values.name}.cfbak`;
      const size = await uploadBackup(client, config, key, process.stdin);
      if (size <= 64) throw new Error('The dump was empty; nothing usable was uploaded.');
      console.error(`Uploaded ${key} (${size} bytes) to ${config.bucket}.`);
      const pruned = await pruneBackups(client, config);
      for (const old of pruned)
        console.error(`Deleted ${old} (older than ${config.retentionDays} days).`);
      return 0;
    }
    case 'list': {
      for (const backup of await listBackups(client, config)) {
        console.error(
          `${backup.lastModified.toISOString()}  ${String(backup.size).padStart(12)}  ${backup.key}`,
        );
      }
      return 0;
    }
    case 'prune': {
      const pruned = await pruneBackups(client, config);
      console.error(`Deleted ${pruned.length} old ${pruned.length === 1 ? 'backup' : 'backups'}.`);
      return 0;
    }
    case 'download': {
      let key = values.key;
      if (!key) {
        console.error('Give the backup with --key (or --key latest).');
        return 2;
      }
      if (key === 'latest') {
        const [latest] = await listBackups(client, config);
        if (!latest) throw new Error(`No backups under ${config.prefix} in ${config.bucket}.`);
        key = latest.key;
      }
      const dir = await mkdtemp(join(tmpdir(), 'credforge-restore-'));
      try {
        const encrypted = join(dir, 'backup.cfbak');
        await downloadBackup(client, config, key, encrypted);
        await decryptToStdout(config.masterKey, encrypted, dir);
        console.error(`Decrypted ${key}.`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return 0;
    }
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
