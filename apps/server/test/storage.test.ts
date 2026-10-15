import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import {
  createLocalStorage,
  createS3Storage,
  type S3Sender,
  type Storage,
  StorageKeyError,
} from '../src/files/storage';

/** The same behavior for every driver. */
function behavesLikeStorage(make: () => Storage) {
  it('stores, reads and deletes objects', async () => {
    const storage = make();
    const key = `test/${randomBytes(6).toString('hex')}/original.png`;
    expect(await storage.get(key)).toBeNull();
    await storage.put(key, Buffer.from('hello'), 'image/png');
    expect((await storage.get(key))?.toString()).toBe('hello');
    await storage.put(key, Buffer.from('again'), 'image/png');
    expect((await storage.get(key))?.toString()).toBe('again');
    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
    await storage.delete(key); // deleting what isn't there is fine
  });

  it('refuses keys credforge never makes', async () => {
    const storage = make();
    for (const key of ['', '../etc/passwd', 'a/../../b', '/abs', 'a//b', 'a\\b', 'a/b c']) {
      await expect(storage.put(key, Buffer.from('x'), 'text/plain'), key).rejects.toThrow(
        StorageKeyError,
      );
    }
  });
}

describe('local storage', () => {
  behavesLikeStorage(() => createLocalStorage(mkdtempSync(join(tmpdir(), 'credforge-storage-'))));
});

/** Stands in for the AWS SDK client: keeps objects in a Map, answers like S3 does. */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; type?: string }>();
  const calls: string[] = [];
  const client: S3Sender = {
    async send(command: unknown) {
      const input = (command as { input: { Bucket: string; Key: string } }).input;
      calls.push(`${(command as object).constructor.name} ${input.Bucket}/${input.Key}`);
      if (command instanceof PutObjectCommand) {
        objects.set(input.Key, {
          body: Buffer.from(command.input.Body as Buffer),
          type: command.input.ContentType,
        });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const object = objects.get(input.Key);
        if (!object)
          throw new NoSuchKey({ message: 'The specified key does not exist.', $metadata: {} });
        return { Body: { transformToByteArray: async () => new Uint8Array(object.body) } };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(input.Key);
        return {};
      }
      throw new Error('unexpected command');
    },
  } as S3Sender;
  return { client, objects, calls };
}

const s3Config = {
  driver: 's3' as const,
  region: 'nyc3',
  bucket: 'credforge-test',
  accessKeyId: 'x',
  secretAccessKey: 'y',
  forcePathStyle: false,
};

describe('s3 storage (SDK calls)', () => {
  behavesLikeStorage(() => createS3Storage(s3Config, fakeS3().client));

  it('writes private objects with their content type to the configured bucket', async () => {
    const fake = fakeS3();
    const storage = createS3Storage(s3Config, fake.client);
    await storage.put('orgs/a/original.png', Buffer.from('png'), 'image/png');
    expect(fake.objects.get('orgs/a/original.png')?.type).toBe('image/png');
    expect(fake.calls).toEqual(['PutObjectCommand credforge-test/orgs/a/original.png']);
    expect(storage.bucket).toBe('credforge-test');
  });
});

/**
 * Against a real bucket (the `credforge-dev` Space) only when its limited key is configured:
 * S3_TEST_ENDPOINT, S3_TEST_REGION, S3_TEST_BUCKET, S3_TEST_ACCESS_KEY_ID, S3_TEST_SECRET_ACCESS_KEY.
 */
const real = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  region: process.env.S3_TEST_REGION,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY,
};
const configured = Boolean(real.region && real.bucket && real.accessKeyId && real.secretAccessKey);

describe.skipIf(!configured)('s3 storage against a real bucket', () => {
  behavesLikeStorage(() =>
    createS3Storage({
      driver: 's3',
      endpoint: real.endpoint,
      region: real.region as string,
      bucket: real.bucket as string,
      accessKeyId: real.accessKeyId as string,
      secretAccessKey: real.secretAccessKey as string,
      forcePathStyle: false,
    }),
  );

  it('keeps objects private', async () => {
    const storage = createS3Storage({
      driver: 's3',
      endpoint: real.endpoint,
      region: real.region as string,
      bucket: real.bucket as string,
      accessKeyId: real.accessKeyId as string,
      secretAccessKey: real.secretAccessKey as string,
      forcePathStyle: false,
    });
    const key = `test/${randomBytes(6).toString('hex')}/private.txt`;
    await storage.put(key, Buffer.from('private'), 'text/plain');
    try {
      const host = new URL(real.endpoint ?? `https://s3.${real.region}.amazonaws.com`).host;
      const response = await fetch(`https://${real.bucket}.${host}/${key}`);
      expect(response.status).toBe(403);
    } finally {
      await storage.delete(key);
    }
  });
});
