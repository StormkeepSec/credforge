import { type Database, eq, instanceSettings } from '@credforge/db';
import type { Logger } from 'pino';
import type { Config } from './config';

const PUBLIC_BASE_URL_KEY = 'public_base_url';

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
