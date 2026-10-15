import type { Database } from '@credforge/db';
import type { Auth } from './auth/auth';
import type { Config } from './config';
import type { KeyEncryption } from './crypto/key-encryption';
import type { EmailOutbox } from './email/outbox';
import type { Storage } from './files/storage';

/** What the HTTP routes need. Built once in server.ts; tests build their own. */
export interface Services {
  config: Config;
  db: Database;
  auth: Auth;
  outbox: EmailOutbox;
  keys: KeyEncryption;
  storage: Storage;
}
