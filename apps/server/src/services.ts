import type { Database } from '@credforge/db';
import type { Auth } from './auth/auth';
import type { Config } from './config';
import type { KeyEncryption } from './crypto/key-encryption';
import type { EmailOutbox } from './email/outbox';
import type { Storage } from './files/storage';
import type { JobQueue } from './jobs/enqueue';

/** What the HTTP routes need. Built once in server.ts; tests build their own. */
export interface Services {
  config: Config;
  db: Database;
  auth: Auth;
  outbox: EmailOutbox;
  keys: KeyEncryption;
  storage: Storage;
  /**
   * Hands batches and status lists to the worker. Tests that leave it out run that work
   * themselves (the database records what is pending, and the worker's sweep finds it too).
   */
  jobs?: JobQueue;
}
