import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { QUEUES } from '../jobs/queues';
import type { EmailMessage, EmailTransport } from './transport';

/**
 * Where the app puts email to be sent. The app never talks to the email provider itself: it
 * enqueues a job and the worker sends it, with retries (design plan §4).
 */
export interface EmailOutbox {
  send(message: EmailMessage): Promise<void>;
}

/** Retries with backoff for about an hour; the job (which holds links with tokens) is deleted soon after. */
export const EMAIL_QUEUE_OPTIONS = {
  retryLimit: 8,
  retryDelay: 15,
  retryBackoff: true,
  deleteAfterSeconds: 24 * 60 * 60,
} as const;

/**
 * How the worker pulls email jobs. One job per fetch, so a failed send retries only that email.
 * pg-boss's default (one poller, a fetch every 2 s) caps sending at 30 a minute and delays
 * verification emails; four pollers every 0.5 s send a backlog at roughly 8 a second.
 */
export const EMAIL_WORK_OPTIONS = {
  batchSize: 1,
  localConcurrency: 4,
  pollingIntervalSeconds: 0.5,
} as const;

export function createQueueOutbox(boss: Pick<PgBoss, 'send'>): EmailOutbox {
  return {
    async send(message) {
      await boss.send(QUEUES.email, message);
    },
  };
}

/** Keeps messages in memory. Used by tests. */
export function createMemoryOutbox(): EmailOutbox & { messages: EmailMessage[] } {
  const messages: EmailMessage[] = [];
  return {
    messages,
    async send(message) {
      messages.push(message);
    },
  };
}

/** The worker's handler for the email queue. Throwing makes pg-boss retry the job. */
export function emailJobHandler(transport: EmailTransport, log: Pick<Logger, 'info'>) {
  return async (message: EmailMessage) => {
    const { messageId } = await transport.send(message);
    log.info({ kind: message.kind, transport: transport.name, messageId }, 'email sent');
  };
}
