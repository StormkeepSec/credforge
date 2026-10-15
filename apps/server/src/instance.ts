import { type Database, eq, instanceSettings } from '@credforge/db';
import type { Logger } from 'pino';
import type { Config } from './config';
import { KeyDecryptionError, type KeyEncryption } from './crypto/key-encryption';

const PUBLIC_BASE_URL_KEY = 'public_base_url';
const MASTER_KEY_CHECK_KEY = 'master_key_check';
const MASTER_KEY_CHECK_VALUE = 'credforge master key check';
const MASTER_KEY_CHECK_AAD = 'credforge:instance:master-key-check';

export class MasterKeyMismatchError extends Error {
  constructor() {
    super(
      'CREDFORGE_MASTER_KEY is not the key this instance was set up with, so it cannot decrypt ' +
        'issuer signing keys. Restore the original key (from your backup of it). Nothing has been changed.',
    );
    this.name = 'MasterKeyMismatchError';
  }
}

/**
 * Records a value encrypted under the master key on first start, and refuses to run if a later
 * start can't decrypt it. A wrong or lost key is then caught at startup, not when an issuer next
 * signs a credential or a status list (design plan §13.4).
 */
export async function enforceMasterKey(
  db: Database,
  keys: KeyEncryption,
  log: Pick<Logger, 'info'>,
): Promise<void> {
  const inserted = await db
    .insert(instanceSettings)
    .values({
      key: MASTER_KEY_CHECK_KEY,
      value: JSON.stringify({
        version: keys.version,
        value: keys.encrypt(MASTER_KEY_CHECK_VALUE, MASTER_KEY_CHECK_AAD),
      }),
    })
    .onConflictDoNothing()
    .returning({ key: instanceSettings.key });
  if (inserted.length > 0) {
    log.info('recorded master key check for this instance');
    return;
  }
  const [row] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, MASTER_KEY_CHECK_KEY));
  try {
    const stored = JSON.parse(row?.value ?? '{}') as { version: number; value: string };
    if (
      keys.decrypt(stored.value, MASTER_KEY_CHECK_AAD, stored.version) !== MASTER_KEY_CHECK_VALUE
    ) {
      throw new MasterKeyMismatchError();
    }
  } catch (error) {
    if (error instanceof KeyDecryptionError || error instanceof SyntaxError) {
      throw new MasterKeyMismatchError();
    }
    throw error;
  }
}

export type BaseUrlDecision =
  | { action: 'ok' }
  | { action: 'change'; previous: string }
  | { action: 'reject'; previous: string };

/** Decides what to do when the configured base URL is compared with the one recorded at setup. */
export function decidePublicBaseUrl(
  recorded: string,
  configured: string,
  allowChange: boolean,
): BaseUrlDecision {
  if (recorded === configured) return { action: 'ok' };
  return allowChange
    ? { action: 'change', previous: recorded }
    : { action: 'reject', previous: recorded };
}

export class PublicBaseUrlChangedError extends Error {
  constructor(previous: string, configured: string) {
    super(
      `PUBLIC_BASE_URL is ${configured}, but this instance was set up with ${previous}. ` +
        'Every credential already issued contains URLs under the original address, so changing it ' +
        'breaks their verification. If you really mean to change it (for example, nothing has been ' +
        'issued yet), start once with ALLOW_PUBLIC_BASE_URL_CHANGE=true.',
    );
    this.name = 'PublicBaseUrlChangedError';
  }
}

/**
 * Records PUBLIC_BASE_URL on first start and refuses to run if it later changes.
 * Safe to call concurrently from the app, worker and migrate processes.
 */
export async function enforcePublicBaseUrl(
  db: Database,
  config: Pick<Config, 'publicBaseUrl' | 'allowPublicBaseUrlChange'>,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<void> {
  const inserted = await db
    .insert(instanceSettings)
    .values({ key: PUBLIC_BASE_URL_KEY, value: config.publicBaseUrl })
    .onConflictDoNothing()
    .returning({ key: instanceSettings.key });
  if (inserted.length > 0) {
    log.info({ publicBaseUrl: config.publicBaseUrl }, 'recorded public base URL for this instance');
    return;
  }

  const [row] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, PUBLIC_BASE_URL_KEY));
  const decision = decidePublicBaseUrl(
    row?.value ?? config.publicBaseUrl,
    config.publicBaseUrl,
    config.allowPublicBaseUrlChange,
  );

  if (decision.action === 'reject') {
    throw new PublicBaseUrlChangedError(decision.previous, config.publicBaseUrl);
  }
  if (decision.action === 'change') {
    await db
      .update(instanceSettings)
      .set({ value: config.publicBaseUrl, updatedAt: new Date() })
      .where(eq(instanceSettings.key, PUBLIC_BASE_URL_KEY));
    log.warn(
      { previous: decision.previous, publicBaseUrl: config.publicBaseUrl },
      'public base URL changed (ALLOW_PUBLIC_BASE_URL_CHANGE=true); remove that setting now',
    );
  }
}
