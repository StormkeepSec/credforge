import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import { masterKey, resolveFileSecrets } from '../config';
import type { S3Sender } from '../files/storage';

/**
 * Database backups (design plan §13.4): a `pg_dump` is encrypted and uploaded to its own bucket
 * (`credforge-backups` on credforge.app) with a key used for nothing else.
 *
 * Encryption: AES-256-GCM under a key derived (HKDF-SHA256) from CREDFORGE_MASTER_KEY and a random
 * salt per backup. A restore needs the master key anyway (it decrypts every issuer's signing
 * key), so no second secret has to be kept. File layout:
 *
 *   "CFBACKUP1\n" (10 bytes) · salt (16) · IV (12) · ciphertext · GCM tag (16)
 */
export const MAGIC = Buffer.from('CFBACKUP1\n', 'latin1');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
/** S3 needs parts of at least 5 MB, except the last. */
const PART_BYTES = 16 * 1024 * 1024;

function backupKey(master: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', master, salt, 'credforge:backup:v1', 32));
}

const positiveInt = (fallback: number) =>
  z.coerce.number({ error: 'must be a whole number' }).int().min(1).default(fallback);

const backupEnv = z.object({
  CREDFORGE_MASTER_KEY: masterKey,
  BACKUP_S3_ENDPOINT: z.string().trim().optional(),
  BACKUP_S3_REGION: z.string().trim().min(1, 'is required'),
  BACKUP_S3_BUCKET: z.string().trim().min(1, 'is required'),
  BACKUP_S3_ACCESS_KEY_ID: z.string().trim().min(1, 'is required'),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().trim().min(1, 'is required'),
  BACKUP_S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  BACKUP_PREFIX: z.string().trim().default('postgres/'),
  BACKUP_RETENTION_DAYS: positiveInt(30),
  BACKUP_KEEP_MIN: positiveInt(7),
});

export interface BackupConfig {
  masterKey: Buffer;
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
  retentionDays: number;
  keepMin: number;
}

/**
 * Reads the backup settings. The endpoint and region default to the app's own S3 settings (the
 * same Spaces region); the bucket and its key are the backup's own (BACKUP_S3_*).
 */
export function loadBackupConfig(source: NodeJS.ProcessEnv = process.env): BackupConfig {
  const env = resolveFileSecrets(source);
  const defined = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = backupEnv.safeParse({
    BACKUP_S3_ENDPOINT: defined.S3_ENDPOINT,
    BACKUP_S3_REGION: defined.S3_REGION,
    ...defined,
  });
  if (!result.success) {
    throw new Error(
      `Invalid backup configuration:\n${result.error.issues
        .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  const value = result.data;
  return {
    masterKey: value.CREDFORGE_MASTER_KEY,
    endpoint: value.BACKUP_S3_ENDPOINT,
    region: value.BACKUP_S3_REGION,
    bucket: value.BACKUP_S3_BUCKET,
    accessKeyId: value.BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: value.BACKUP_S3_SECRET_ACCESS_KEY,
    forcePathStyle: value.BACKUP_S3_FORCE_PATH_STYLE,
    prefix: value.BACKUP_PREFIX,
    retentionDays: value.BACKUP_RETENTION_DAYS,
    keepMin: value.BACKUP_KEEP_MIN,
  };
}

export function createBackupClient(config: BackupConfig): S3Sender {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // The SDK's default CRC32 checksums aren't supported by every S3-compatible service.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/** Encrypts a stream into the backup format, yielding chunks as they are ready. */
export async function* encrypt(master: Buffer, input: AsyncIterable<Buffer>) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', backupKey(master, salt), iv);
  yield Buffer.concat([MAGIC, salt, iv]);
  for await (const chunk of input) {
    const out = cipher.update(chunk);
    if (out.length > 0) yield out;
  }
  const last = cipher.final();
  if (last.length > 0) yield last;
  yield cipher.getAuthTag();
}

/**
 * Decrypts a backup file into `output`. The GCM tag is checked before this resolves; on a wrong
 * key or a damaged file it rejects (the caller discards what was written).
 */
export async function decryptFile(master: Buffer, path: string, output: Writable): Promise<void> {
  const size = (await stat(path)).size;
  if (size < HEADER_BYTES + TAG_BYTES) throw new Error('Not a credforge backup (too short).');
  const handle = await open(path, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (!timingSafeEqual(header.subarray(0, MAGIC.length), MAGIC)) {
    throw new Error('Not a credforge backup (wrong header).');
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = header.subarray(MAGIC.length + SALT_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', backupKey(master, salt), iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(path, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }),
      decipher,
      output,
    );
  } catch (error) {
    throw new Error(
      `The backup couldn't be decrypted: a different CREDFORGE_MASTER_KEY, or a damaged file (${(error as Error).message}).`,
    );
  }
}

/** Collects a stream into parts of `size` bytes (the last one may be smaller). */
async function* parts(input: AsyncIterable<Buffer>, size: number) {
  let pending: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    pending.push(chunk);
    length += chunk.length;
    while (length >= size) {
      const all = Buffer.concat(pending);
      yield all.subarray(0, size);
      pending = [all.subarray(size)];
      length = all.length - size;
    }
  }
  if (length > 0) yield Buffer.concat(pending);
}

/** Encrypts `input` and uploads it as `key`; returns the stored size. */
export async function uploadBackup(
  client: S3Sender,
  config: BackupConfig,
  key: string,
  input: AsyncIterable<Buffer>,
): Promise<number> {
  const Bucket = config.bucket;
  const iterator = parts(encrypt(config.masterKey, input), PART_BYTES)[Symbol.asyncIterator]();
  const first = await iterator.next();
  const firstPart = first.done ? Buffer.alloc(0) : first.value;
  const second = first.done ? first : await iterator.next();
  if (second.done) {
    // Small enough for one request.
    await client.send(
      new PutObjectCommand({
        Bucket,
        Key: key,
        Body: firstPart,
        ContentType: 'application/octet-stream',
      }),
    );
    return firstPart.length;
  }

  const created = await client.send(
    new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: 'application/octet-stream' }),
  );
  const UploadId = created.UploadId;
  if (!UploadId) throw new Error('The storage service started no multipart upload.');
  const etags: { ETag: string; PartNumber: number }[] = [];
  let total = 0;
  const uploadPart = async (Body: Buffer) => {
    const PartNumber = etags.length + 1;
    const uploaded = await client.send(
      new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber, Body }),
    );
    if (!uploaded.ETag) throw new Error(`Part ${PartNumber} was stored without an ETag.`);
    etags.push({ ETag: uploaded.ETag, PartNumber });
    total += Body.length;
  };
  try {
    await uploadPart(firstPart);
    await uploadPart(second.value);
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      await uploadPart(next.value);
    }
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket,
        Key: key,
        UploadId,
        MultipartUpload: { Parts: etags },
      }),
    );
  } catch (error) {
    await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId }));
    throw error;
  }
  return total;
}

export interface StoredBackup {
  key: string;
  size: number;
  lastModified: Date;
}

/** Every backup under the prefix, newest first. */
export async function listBackups(client: S3Sender, config: BackupConfig): Promise<StoredBackup[]> {
  const found: StoredBackup[] = [];
  let ContinuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: config.prefix,
        ContinuationToken,
      }),
    );
    for (const item of page.Contents ?? []) {
      if (item.Key?.endsWith('.cfbak')) {
        found.push({
          key: item.Key,
          size: item.Size ?? 0,
          lastModified: item.LastModified ?? new Date(0),
        });
      }
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return found.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}

/**
 * Deletes backups older than the retention period, but always keeps the newest `keepMin`, so a
 * stretch of failed backups never leaves none behind.
 */
export async function pruneBackups(
  client: S3Sender,
  config: BackupConfig,
  now = new Date(),
): Promise<string[]> {
  const cutoff = now.getTime() - config.retentionDays * 24 * 60 * 60 * 1000;
  const expired = (await listBackups(client, config))
    .slice(config.keepMin)
    .filter((backup) => backup.lastModified.getTime() < cutoff);
  for (const backup of expired) {
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: backup.key }));
  }
  return expired.map((backup) => backup.key);
}

/** Downloads a backup object (still encrypted) to a local file. */
export async function downloadBackup(
  client: S3Sender,
  config: BackupConfig,
  key: string,
  path: string,
): Promise<void> {
  const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
  if (!object.Body) throw new Error(`Backup ${key} is empty.`);
  await pipeline(object.Body as Readable, createWriteStream(path));
}
