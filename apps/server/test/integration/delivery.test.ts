import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { credential, emailMessage, eq, organization, sql } from '@credforge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMAIL_QUEUE_OPTIONS, emailJobHandler, transactionDatabase } from '../../src/email/outbox';
import { createDeliveryTracker } from '../../src/email/tracking';
import { type EmailMessage, PermanentEmailError } from '../../src/email/transport';
import { QUEUES } from '../../src/jobs/queues';
import { pngWithMetadata } from '../support/images';
import { newUser, type TestClient } from './support/client';
import { createTestEnvironment, type TestEnvironment } from './support/harness';

/**
 * Award email delivery (design plan §8.4): the email job is written in the award's transaction,
 * the worker records sends and failures without ever sending twice, and SendGrid's signed Event
 * Webhook moves the status on.
 */

let env: TestEnvironment;
let owner: TestClient;
let orgId: string;
let achievementId: string;
let privateKey: KeyObject;

const silent = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  privateKey = pair.privateKey;
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  env = await createTestEnvironment(
    { SIGNUP_MODE: 'open', SENDGRID_WEBHOOK_PUBLIC_KEY: publicKey },
    { queue: true },
  );
  owner = await newUser(env);
  orgId = (
    (await owner.post('/api/v1/orgs', { name: 'Delivery Academy' })).json() as { id: string }
  ).id;
  await owner.post(`/api/v1/orgs/${orgId}/issuers`, {
    name: 'Delivery Academy',
    email: 'help@delivery.example',
  });
  achievementId = (
    (
      await owner.post(`/api/v1/orgs/${orgId}/achievements`, {
        name: 'Delivered',
        description: 'Arrives.',
        criteriaUrl: 'https://delivery.example/criteria',
      })
    ).json() as { id: string }
  ).id;
  await owner.upload(
    `/api/v1/orgs/${orgId}/achievements/${achievementId}/image`,
    await pngWithMetadata(256),
    'image/png',
  );
  await owner.post(`/api/v1/orgs/${orgId}/achievements/${achievementId}/publish`);
});
afterAll(async () => {
  await env?.close();
});

async function jobs(): Promise<{ data: EmailMessage }[]> {
  const result = await env.ownerPool.query(`select data from pgboss.job where name = $1`, [
    QUEUES.email,
  ]);
  return result.rows as { data: EmailMessage }[];
}

async function jobsTo(email: string) {
  return (await jobs()).filter((row) => row.data.to === email);
}

/** Runs `body` while every job insert waits on a lock, as on a slow or busy database. */
async function holdingJobInserts<T>(body: () => Promise<T>): Promise<T> {
  const lock = await env.ownerPool.connect();
  try {
    await lock.query('begin');
    await lock.query('lock table pgboss.job in exclusive mode');
    return await body();
  } finally {
    await lock.query('rollback');
    lock.release();
  }
}

async function awardTo(email: string) {
  const response = await owner.post(`/api/v1/orgs/${orgId}/credentials`, {
    achievementId,
    recipient: { name: 'Alex Kim', email },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string; emails: { id: string }[] };
}

describe('the award email job', () => {
  it('is written in the award transaction', async () => {
    const before = await jobs();
    const award = await awardTo('alex@example.org');
    const after = await jobs();
    expect(after.length).toBe(before.length + 1);
    const job = after.find((row) => row.data.trackingId === award.emails[0]?.id);
    expect(job?.data).toMatchObject({ kind: 'award', to: 'alex@example.org' });
    expect(job?.data.text).toContain(`/credentials/${award.id}?t=`);
  });

  it('disappears with a rolled-back transaction', async () => {
    const before = (await jobs()).length;
    await expect(
      env.db.transaction(async (tx) => {
        await env.boss?.send(
          QUEUES.email,
          { kind: 'award', to: 'x@example.org' },
          {
            db: transactionDatabase(tx),
          },
        );
        expect((await jobs()).length).toBe(before); // not visible outside the transaction
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect((await jobs()).length).toBe(before);
  });

  it('is not written when the award fails', async () => {
    const before = (await jobs()).length;
    const response = await owner.post(`/api/v1/orgs/${orgId}/credentials`, {
      achievementId: crypto.randomUUID(),
      recipient: { name: 'Nobody', email: 'nobody@example.org' },
    });
    expect(response.statusCode).toBe(400);
    expect((await jobs()).length).toBe(before);
  });
});

describe('email sent in the background', () => {
  // Sign-up doesn't wait for its verification email to be enqueued. The test outbox must still
  // have the message when sign-up answers: newUser reads the link from it, and failed this file's
  // setup on busy machines when the outbox only recorded a message once its job was written.
  it("doesn't hold up sign-up, and its job is written after", async () => {
    const client = await holdingJobInserts(async () => {
      const signedUp = await newUser(env, { twoFactor: false });
      expect(await jobsTo(signedUp.email)).toEqual([]);
      return signedUp;
    });
    await expect.poll(async () => (await jobsTo(client.email)).length).toBe(1);
    expect((await jobsTo(client.email))[0]?.data.kind).toBe('verify-email');
  });
});

describe('the worker', () => {
  it('sends once and records it; a repeated job does not send again', async () => {
    const award = await awardTo('once@example.org');
    const job = (await jobs()).find((row) => row.data.trackingId === award.emails[0]?.id);
    if (!job) throw new Error('no job');
    const sent: string[] = [];
    const handler = emailJobHandler(
      {
        name: 'sendgrid',
        async send(message) {
          sent.push(message.to);
          return { messageId: 'sg-123' };
        },
      },
      silent,
      createDeliveryTracker(env.db),
    );
    await handler(job.data);
    await handler(job.data); // e.g. the job was picked up again after a crash
    expect(sent).toEqual(['once@example.org']);
    const [row] = await env.ownerDb
      .select()
      .from(emailMessage)
      .where(eq(emailMessage.id, award.emails[0]?.id ?? ''));
    expect(row).toMatchObject({
      status: 'sent',
      transport: 'sendgrid',
      providerMessageId: 'sg-123',
      attempts: 1,
    });
  });

  it('retries transient failures and gives up on permanent ones', async () => {
    const award = await awardTo('flaky@example.org');
    const id = award.emails[0]?.id ?? '';
    const job = (await jobs()).find((row) => row.data.trackingId === id);
    if (!job) throw new Error('no job');
    const tracker = createDeliveryTracker(env.db);
    const transient = emailJobHandler(
      {
        name: 'sendgrid',
        async send() {
          throw new Error('503 Service Unavailable');
        },
      },
      silent,
      tracker,
    );
    await expect(transient(job.data, { retryCount: 0 })).rejects.toThrow('503');
    let [row] = await env.ownerDb.select().from(emailMessage).where(eq(emailMessage.id, id));
    expect(row).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastError: '503 Service Unavailable',
    });

    const permanent = emailJobHandler(
      {
        name: 'sendgrid',
        async send() {
          throw new PermanentEmailError('SendGrid refused the message (400): bad address');
        },
      },
      silent,
      tracker,
    );
    await permanent(job.data, { retryCount: 1 }); // doesn't throw: no retry
    [row] = await env.ownerDb.select().from(emailMessage).where(eq(emailMessage.id, id));
    expect(row).toMatchObject({ status: 'failed', attempts: 2 });

    // The last retry of a transient failure also ends as failed.
    const other = await awardTo('last@example.org');
    const otherJob = (await jobs()).find((entry) => entry.data.trackingId === other.emails[0]?.id);
    await expect(
      transient(otherJob?.data as EmailMessage, { retryCount: EMAIL_QUEUE_OPTIONS.retryLimit }),
    ).rejects.toThrow();
    const [last] = await env.ownerDb
      .select()
      .from(emailMessage)
      .where(eq(emailMessage.id, other.emails[0]?.id ?? ''));
    expect(last?.status).toBe('failed');
  });

  it("doesn't send for a suspended org", async () => {
    const award = await awardTo('suspended@example.org');
    const job = (await jobs()).find((row) => row.data.trackingId === award.emails[0]?.id);
    await env.ownerDb
      .update(organization)
      .set({ status: 'suspended' })
      .where(eq(organization.id, orgId));
    const sent: string[] = [];
    await emailJobHandler(
      {
        name: 'smtp',
        async send(message) {
          sent.push(message.to);
          return {};
        },
      },
      silent,
      createDeliveryTracker(env.db),
    )(job?.data as EmailMessage);
    await env.ownerDb
      .update(organization)
      .set({ status: 'active' })
      .where(eq(organization.id, orgId));
    expect(sent).toEqual([]);
    const [row] = await env.ownerDb
      .select()
      .from(emailMessage)
      .where(eq(emailMessage.id, award.emails[0]?.id ?? ''));
    expect(row).toMatchObject({
      status: 'failed',
      lastError: expect.stringContaining('suspended'),
    });
  });
});

describe('the SendGrid Event Webhook', () => {
  function signed(events: unknown[], timestamp = String(Math.floor(Date.now() / 1000))) {
    const body = JSON.stringify(events);
    const signature = sign('sha256', Buffer.from(timestamp + body), privateKey).toString('base64');
    return { body, signature, timestamp };
  }

  async function post(body: string, signature: string, timestamp: string) {
    return env.app.inject({
      method: 'POST',
      url: '/api/webhooks/sendgrid',
      headers: {
        'content-type': 'application/json',
        'x-twilio-email-event-webhook-signature': signature,
        'x-twilio-email-event-webhook-timestamp': timestamp,
      },
      payload: body,
    });
  }

  it('refuses unsigned and tampered requests', async () => {
    const { body, signature, timestamp } = signed([{ event: 'delivered' }]);
    expect((await post(body, '', timestamp)).statusCode).toBe(403);
    expect((await post(body.replace('delivered', 'bounce'), signature, timestamp)).statusCode).toBe(
      403,
    );
    expect((await post(body, signature, String(Number(timestamp) + 1))).statusCode).toBe(403);
  });

  it('records delivery, bounces and spam reports, once each, never going backwards', async () => {
    const delivered = await awardTo('delivered@example.org');
    const bounced = await awardTo('bounced@example.org');
    const deliveredId = delivered.emails[0]?.id;
    const bouncedId = bounced.emails[0]?.id;
    // The worker has sent the second one; its events can match by SendGrid's message id too.
    await env.ownerDb
      .update(emailMessage)
      .set({ status: 'sent', providerMessageId: 'abc123XYZ' })
      .where(eq(emailMessage.id, bouncedId ?? ''));

    const now = Math.floor(Date.now() / 1000);
    const batch = [
      // Shapes as SendGrid sends them (fields trimmed); custom args arrive at the top level.
      {
        email: 'delivered@example.org',
        timestamp: now,
        event: 'processed',
        sg_event_id: 'ev-1',
        sg_message_id: 'zzz.filter0001.1',
        credforge_email_id: deliveredId,
        category: ['award'],
      },
      {
        email: 'delivered@example.org',
        timestamp: now + 2,
        event: 'delivered',
        sg_event_id: 'ev-2',
        sg_message_id: 'zzz.filter0001.1',
        credforge_email_id: deliveredId,
        response: '250 OK',
      },
      {
        email: 'bounced@example.org',
        timestamp: now + 3,
        event: 'bounce',
        type: 'bounce',
        sg_event_id: 'ev-3',
        sg_message_id: 'abc123XYZ.filter0002.2',
        reason: '550 5.1.1 The email account that you tried to reach does not exist.',
        status: '5.1.1',
      },
      // Out of order: a late "delivered" for the bounced message must not hide the bounce.
      {
        email: 'bounced@example.org',
        timestamp: now + 1,
        event: 'delivered',
        sg_event_id: 'ev-4',
        sg_message_id: 'abc123XYZ.filter0002.2',
      },
      { email: 'x@example.org', timestamp: now, event: 'open', sg_event_id: 'ev-5' },
    ];
    const { body, signature, timestamp } = signed(batch);
    expect((await post(body, signature, timestamp)).statusCode).toBe(204);
    // SendGrid retries a batch it thinks failed: nothing changes the second time.
    expect((await post(body, signature, timestamp)).statusCode).toBe(204);

    const rows = await env.ownerDb
      .select()
      .from(emailMessage)
      .where(sql`${emailMessage.id} in (${deliveredId}, ${bouncedId})`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(deliveredId ?? '')).toMatchObject({ status: 'delivered' });
    expect(byId.get(deliveredId ?? '')?.events.map((event) => event.event)).toEqual([
      'processed',
      'delivered',
    ]);
    expect(byId.get(bouncedId ?? '')).toMatchObject({
      status: 'bounced',
      lastError: expect.stringContaining('does not exist'),
    });
    expect(byId.get(bouncedId ?? '')?.bouncedAt).toBeInstanceOf(Date);
    expect(byId.get(bouncedId ?? '')?.events).toHaveLength(2);

    // The issuer sees it.
    const details = await owner.get(`/api/v1/orgs/${orgId}/credentials/${bounced.id}`);
    expect(details.json()).toMatchObject({
      delivery: 'bounced',
      emails: [{ status: 'bounced', events: [{ event: 'bounce' }, { event: 'delivered' }] }],
    });
    const [row] = await env.ownerDb.select().from(credential).where(eq(credential.id, bounced.id));
    expect(row?.status).toBe('issued');
  });
});
