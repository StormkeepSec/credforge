import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  type BackupConfig,
  decryptFile,
  encrypt,
  listBackups,
  loadBackupConfig,
  MAGIC,
  pruneBackups,
  uploadBackup,
} from '../src/backup/backup';
import type { S3Sender } from '../src/files/storage';

const master = randomBytes(32);

const config: BackupConfig = {
  masterKey: master,
  region: 'sfo3',
  bucket: 'credforge-backups',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  forcePathStyle: false,
  prefix: 'postgres/',
  retentionDays: 30,
  keepMin: 7,
};

async function* chunks(data: Buffer, size = 65_536) {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

async function encryptToFile(data: Buffer, key = master): Promise<string> {
  const out: Buffer[] = [];
  for await (const chunk of encrypt(key, chunks(data))) out.push(chunk);
  const path = join(mkdtempSync(join(tmpdir(), 'credforge-backup-')), 'b.cfbak');
  writeFileSync(path, Buffer.concat(out));
  return path;
}

function collect(): { stream: Writable; data: () => Buffer } {
  const parts: Buffer[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, done) {
        parts.push(chunk);
        done();
      },
    }),
    data: () => Buffer.concat(parts),
  };
}

/** A stand-in S3 client that records what it was sent and keeps objects in memory. */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; lastModified: Date }>();
  const multipart = new Map<string, Buffer[]>();
  const calls: string[] = [];
  const client: S3Sender = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name;
      const input = command.input as {
        Key: string;
        Body?: Buffer;
        UploadId?: string;
        PartNumber?: number;
      };
      calls.push(name);
      switch (name) {
        case 'PutObjectCommand':
          objects.set(input.Key, { body: input.Body as Buffer, lastModified: new Date() });
          return {};
        case 'CreateMultipartUploadCommand':
          multipart.set('u1', []);
          return { UploadId: 'u1' };
        case 'UploadPartCommand':
          multipart.get('u1')?.push(Buffer.from(input.Body as Buffer));
          return { ETag: `"etag-${input.PartNumber}"` };
        case 'CompleteMultipartUploadCommand':
          objects.set(input.Key, {
            body: Buffer.concat(multipart.get('u1') ?? []),
            lastModified: new Date(),
          });
          return {};
        case 'ListObjectsV2Command':
          return {
            Contents: [...objects].map(([Key, object]) => ({
              Key,
              Size: object.body.length,
              LastModified: object.lastModified,
            })),
          };
        case 'DeleteObjectCommand':
          objects.delete(input.Key);
          return {};
        default:
          throw new Error(`unexpected ${name}`);
      }
    },
  } as unknown as S3Sender;
  return { client, objects, calls };
}

describe('backup encryption', () => {
  it('round-trips, and starts with the format header', async () => {
    const data = randomBytes(300_000);
    const path = await encryptToFile(data);
    expect(readFileSync(path).subarray(0, MAGIC.length)).toEqual(MAGIC);
    expect(readFileSync(path).includes(data.subarray(0, 64))).toBe(false);
    const out = collect();
    await decryptFile(master, path, out.stream);
    expect(out.data().equals(data)).toBe(true);
  });

  it('refuses a different master key and a damaged file', async () => {
    const path = await encryptToFile(randomBytes(10_000));
    await expect(decryptFile(randomBytes(32), path, collect().stream)).rejects.toThrow(
      /different CREDFORGE_MASTER_KEY/,
    );
    const bytes = readFileSync(path);
    bytes[MAGIC.length + 40] = (bytes[MAGIC.length + 40] ?? 0) ^ 1;
    writeFileSync(path, bytes);
    await expect(decryptFile(master, path, collect().stream)).rejects.toThrow();
  });
});

describe('uploading', () => {
  it('sends a small dump in one request', async () => {
    const s3 = fakeS3();
    await uploadBackup(s3.client, config, 'postgres/a.cfbak', chunks(randomBytes(1000)));
    expect(s3.calls).toEqual(['PutObjectCommand']);
  });

  it('sends a large dump in parts that decrypt back to the dump', async () => {
    const s3 = fakeS3();
    const data = randomBytes(40 * 1024 * 1024);
    const size = await uploadBackup(s3.client, config, 'postgres/b.cfbak', chunks(data));
    expect(s3.calls.filter((call) => call === 'UploadPartCommand')).toHaveLength(3);
    expect(s3.calls.at(-1)).toBe('CompleteMultipartUploadCommand');
    const stored = s3.objects.get('postgres/b.cfbak')?.body ?? Buffer.alloc(0);
    expect(stored.length).toBe(size);
    const path = join(mkdtempSync(join(tmpdir(), 'credforge-backup-')), 'b.cfbak');
    writeFileSync(path, stored);
    const out = collect();
    await decryptFile(master, path, out.stream);
    expect(out.data().equals(data)).toBe(true);
  });
});

describe('retention', () => {
  it('deletes backups past their retention, but keeps the newest few', async () => {
    const s3 = fakeS3();
    const day = 24 * 60 * 60 * 1000;
    const now = new Date('2026-12-31T03:00:00Z');
    for (let age = 0; age < 40; age++) {
      s3.objects.set(`postgres/credforge-${age}.dump.cfbak`, {
        body: Buffer.from('x'),
        lastModified: new Date(now.getTime() - age * day),
      });
    }
    s3.objects.set('postgres/notes.txt', { body: Buffer.from('x'), lastModified: new Date(0) });
    const deleted = await pruneBackups(s3.client, config, now);
    expect(deleted).toHaveLength(9);
    expect((await listBackups(s3.client, config)).length).toBe(31);
    expect(s3.objects.has('postgres/notes.txt')).toBe(true);

    // Only old backups left (backups failed for weeks): the newest seven stay.
    const stale = fakeS3();
    for (let age = 50; age < 60; age++) {
      stale.objects.set(`postgres/old-${age}.cfbak`, {
        body: Buffer.from('x'),
        lastModified: new Date(now.getTime() - age * day),
      });
    }
    expect(await pruneBackups(stale.client, config, now)).toHaveLength(3);
  });
});

describe('settings', () => {
  it('uses the app’s S3 endpoint and region, and its own bucket and key', () => {
    const loaded = loadBackupConfig({
      CREDFORGE_MASTER_KEY: master.toString('base64'),
      S3_ENDPOINT: 'https://sfo3.digitaloceanspaces.com',
      S3_REGION: 'sfo3',
      BACKUP_S3_BUCKET: 'credforge-backups',
      BACKUP_S3_ACCESS_KEY_ID: 'id',
      BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
    });
    expect(loaded).toMatchObject({
      endpoint: 'https://sfo3.digitaloceanspaces.com',
      region: 'sfo3',
      bucket: 'credforge-backups',
      prefix: 'postgres/',
      retentionDays: 30,
      keepMin: 7,
    });
    expect(() => loadBackupConfig({ CREDFORGE_MASTER_KEY: master.toString('base64') })).toThrow(
      /BACKUP_S3_BUCKET/,
    );
  });
});
